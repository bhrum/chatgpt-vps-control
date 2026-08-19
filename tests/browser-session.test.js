import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "../lib/browser-accessibility.js";
import { browserSessionUtility, listBrowserSessions, resolveBrowserUploadFiles, sanitizeBrowserPdfName, startBrowserSession } from "../lib/browser-session.js";

const extensionHomeForTests = await mkdtemp(join(tmpdir(), "browser-extension-empty-"));
const originalExtensionHome = process.env.COMPUTER_BROWSER_EXTENSION_HOME;
process.env.COMPUTER_BROWSER_EXTENSION_HOME = extensionHomeForTests;
test.after(async () => {
  if (originalExtensionHome === undefined) delete process.env.COMPUTER_BROWSER_EXTENSION_HOME;
  else process.env.COMPUTER_BROWSER_EXTENSION_HOME = originalExtensionHome;
  await rm(extensionHomeForTests, { recursive: true, force: true });
});


test("raw CDP transport routes commands to flattened child sessions", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const received = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      socket.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result: { ok: true } }));
    });
  });
  const address = server.address();
  const client = new CdpClient(`ws://127.0.0.1:${address.port}/devtools/page/test`);
  try {
    assert.deepEqual(await client.sendSession("child-session-1", "Runtime.evaluate", { expression: "1+1" }), { ok: true });
    assert.equal(received.length, 1);
    assert.equal(received[0].sessionId, "child-session-1");
    assert.equal(received[0].method, "Runtime.evaluate");
    assert.deepEqual(received[0].params, { expression: "1+1" });
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("isolated browser sessions reject privileged and script URL schemes before launch", async () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "devtools://devtools/"]) {
    await assert.rejects(
      startBrowserSession({ name: "url-policy-test", url, headless: true }),
      /does not allow|absolute http/i,
    );
  }
});

test("managed browser utilities reject unsafe session names before target or filesystem access", async () => {
  await assert.rejects(
    browserSessionUtility({ name: "../ordinary-profile", action: "downloads" }),
    /name must be 1-64 characters/i,
  );
});

test("isolated browser session names fail closed before filesystem or process use", async () => {
  for (const name of ["", "../escape", "has space", ".hidden", "x".repeat(65)]) {
    await assert.rejects(
      startBrowserSession({ name, url: "about:blank", headless: true }),
      /name must be 1-64 characters/i,
    );
  }
});

test("managed sessions cannot shadow reserved attached browser identities", async () => {
  await assert.rejects(
    startBrowserSession({ name: "attached-user", url: "about:blank", headless: true }),
    /reserved for explicitly configured existing browsers/i,
  );
});

test("browser file uploads accept approved regular files and reject path escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-upload-root-"));
  const outside = await mkdtemp(join(tmpdir(), "browser-upload-outside-"));
  const sessions = await mkdtemp(join(tmpdir(), "browser-upload-sessions-"));
  const approved = join(root, "approved.txt");
  const escaped = join(outside, "escaped.txt");
  const linked = join(root, "linked.txt");
  const oldRoots = process.env.COMPUTER_BROWSER_UPLOAD_ROOTS;
  const oldSessions = process.env.COMPUTER_BROWSER_SESSION_DIR;
  try {
    await writeFile(approved, "approved");
    await writeFile(escaped, "escaped");
    await symlink(escaped, linked);
    await mkdir(join(root, "directory"));
    process.env.COMPUTER_BROWSER_UPLOAD_ROOTS = root;
    process.env.COMPUTER_BROWSER_SESSION_DIR = sessions;
    assert.deepEqual(await resolveBrowserUploadFiles("upload-test", [approved]), [await realpath(approved)]);
    assert.deepEqual(await resolveBrowserUploadFiles("upload-test", []), []);
    const exported = join(sessions, "upload-test", "exports", "generated.pdf");
    await writeFile(exported, "%PDF-test");
    assert.deepEqual(await resolveBrowserUploadFiles("upload-test", [exported]), [await realpath(exported)]);
    await assert.rejects(resolveBrowserUploadFiles("upload-test", [escaped]), /outside COMPUTER_BROWSER_UPLOAD_ROOTS/i);
    await assert.rejects(resolveBrowserUploadFiles("upload-test", [linked]), /outside COMPUTER_BROWSER_UPLOAD_ROOTS/i);
    await assert.rejects(resolveBrowserUploadFiles("upload-test", [join(root, "directory")]), /not a regular file/i);
    process.env.COMPUTER_BROWSER_UPLOAD_ROOTS = "/";
    await assert.rejects(resolveBrowserUploadFiles("upload-test", [escaped]), /outside COMPUTER_BROWSER_UPLOAD_ROOTS/i);
  } finally {
    if (oldRoots === undefined) delete process.env.COMPUTER_BROWSER_UPLOAD_ROOTS; else process.env.COMPUTER_BROWSER_UPLOAD_ROOTS = oldRoots;
    if (oldSessions === undefined) delete process.env.COMPUTER_BROWSER_SESSION_DIR; else process.env.COMPUTER_BROWSER_SESSION_DIR = oldSessions;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(sessions, { recursive: true, force: true });
  }
});

test("browser PDF export filenames cannot escape the private artifact directory", () => {
  assert.equal(sanitizeBrowserPdfName("../../private/report.pdf"), "private-report.pdf");
  assert.equal(sanitizeBrowserPdfName("Quarterly Report.pdf"), "Quarterly-Report.pdf");
  assert.match(sanitizeBrowserPdfName("..."), /^page-.*\.pdf$/);
  assert.ok(sanitizeBrowserPdfName("x".repeat(1000)).length <= 164);
});

test("explicit loopback CDP endpoints appear as claim-bound attached sessions", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version") {
      response.end(JSON.stringify({ Browser: "TestBrowser/1", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/stable` }));
    } else if (request.url === "/json/list") {
      response.end(JSON.stringify([{ type: "page", id: "tab-1", title: "Signed in", url: "https://example.test/", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/tab-1` }]));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const oldEndpoints = process.env.COMPUTER_CDP_ENDPOINTS;
  const oldRoot = process.env.COMPUTER_BROWSER_SESSION_DIR;
  const root = await mkdtemp(join(tmpdir(), "browser-attach-test-"));
  try {
    process.env.COMPUTER_CDP_ENDPOINTS = `http://127.0.0.1:${server.address().port}`;
    process.env.COMPUTER_BROWSER_SESSION_DIR = root;
    const sessions = await listBrowserSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, "attached");
    assert.match(sessions[0].name, /^attached-[a-f0-9]{16}$/);
    assert.equal(sessions[0].targets[0].id, "tab-1");
    assert.match(sessions[0].targets[0].claim, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(sessions[0].targets[0].owner, "user");
    assert.equal(sessions[0].targets[0].retained, true);
  } finally {
    if (oldEndpoints === undefined) delete process.env.COMPUTER_CDP_ENDPOINTS; else process.env.COMPUTER_CDP_ENDPOINTS = oldEndpoints;
    if (oldRoot === undefined) delete process.env.COMPUTER_BROWSER_SESSION_DIR; else process.env.COMPUTER_BROWSER_SESSION_DIR = oldRoot;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
