import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

const token = process.env.MCP_SMOKE_TOKEN;
const port = Number(process.env.MCP_SMOKE_PORT || 18995);
const cdpEndpoint = (process.env.MCP_SMOKE_CDP_ENDPOINT || "http://127.0.0.1:9222").replace(/\/$/, "");
if (!token) throw new Error("MCP_SMOKE_TOKEN is required.");

async function startManagedBrowserFixture() {
  const server = createServer((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=computer-browser-ci.txt" });
      response.end("managed browser download ok");
      return;
    }
    if (request.url === "/dialog") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>dialog fixture</title><p>dialog page</p><script>setTimeout(()=>alert('managed-dialog-ok'),500)</script>");
      return;
    }
    if (request.url === "/download-page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>download fixture</title><a id=d href=/download download>download</a><script>setTimeout(()=>d.click(),500)</script>");
      return;
    }
    if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>cross origin frame</title><label for=frame-input>Frame input</label><input id=frame-input aria-label="Frame input"><button id=frame-run onclick="frameStatus.textContent='frame-'+frameInput.value">Run frame</button><div id=frame-status role=status>frame-idle</div><script>const frameInput=document.getElementById('frame-input'),frameStatus=document.getElementById('frame-status')</script>`);
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>automation popup</title><p>popup-ok</p>");
      return;
    }
    const fixturePort = server.address().port;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>utility fixture</title><h1>Managed utility export</h1><p>utility-text-ok</p>
      <button id=cua-run style="position:fixed;z-index:1000;left:8px;top:8px" onclick="document.getElementById('cua-status').textContent='cua-ok'">CUA run</button><div id=cua-status style="position:fixed;z-index:1000;left:8px;top:44px">cua-idle</div>
      <label for=locator-input>Locator input</label><input id=locator-input aria-label="Locator input">
      <label><input id=locator-check type=checkbox> Locator check</label>
      <select id=locator-select aria-label="Locator select"><option value=one>One</option><option value=two>Two</option></select>
      <label for=locator-file>Locator file</label><input id=locator-file type=file aria-label="Locator file">
      <div id=upload-status role=status>upload-idle</div>
      <div id=drag-source draggable=true style="width:80px;height:40px;background:#acf">Drag source</div>
      <div id=drag-target style="width:120px;height:60px;background:#ddd">Drop target</div>
      <div id=drag-status role=status>drag-idle</div>
      <iframe id=cross-frame title="Cross origin fixture" src="http://localhost:${fixturePort}/frame"></iframe>
      <button id=popup-run onclick="window.open('/popup','automation-popup')">Open popup</button>
      <button id=locator-run onclick="locatorStatus.textContent=locatorInput.value+':'+locatorCheck.checked+':'+locatorSelect.value">Run locator</button>
      <div id=locator-status role=status>locator-idle</div>
      <script>const locatorInput=document.getElementById('locator-input'),locatorCheck=document.getElementById('locator-check'),locatorSelect=document.getElementById('locator-select'),locatorFile=document.getElementById('locator-file'),uploadStatus=document.getElementById('upload-status'),dragSource=document.getElementById('drag-source'),dragTarget=document.getElementById('drag-target'),dragStatus=document.getElementById('drag-status'),locatorStatus=document.getElementById('locator-status');locatorFile.addEventListener('change',()=>uploadStatus.textContent=locatorFile.files[0]?.name||'empty');dragSource.addEventListener('dragstart',event=>event.dataTransfer.setData('text/plain','ok'));dragTarget.addEventListener('dragover',event=>event.preventDefault());dragTarget.addEventListener('drop',event=>{event.preventDefault();dragStatus.textContent='drag-'+event.dataTransfer.getData('text/plain')});console.log('managed-log-ok')</script>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}


async function createBrowserFixture() {
  const html = `<!doctype html><meta charset="utf-8"><title>Computer Semantic MCP Test</title>
    <label for="name">Name</label><input id="name" aria-label="Semantic name">
    <button id="go" onclick="document.getElementById('status').textContent='clicked:'+document.getElementById('name').value">Run semantic test</button>
    <div id="status" role="status">idle</div>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const response = await fetch(`${cdpEndpoint}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not create CDP target: ${response.status} ${await response.text()}`);
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let nextId = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (!message.id || !pending.has(message.id)) return;
    const callback = pending.get(message.id);
    pending.delete(message.id);
    callback(message);
  });
  const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`CDP ${method} timed out.`)); }, 5000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) rejectCall(new Error(message.error.message));
      else resolveCall(message.result ?? {});
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call("Page.enable");
  await call("Page.navigate", { url });
  let loaded = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { result } = await call("Runtime.evaluate", {
      expression: "({ready:document.readyState,controls:document.querySelectorAll('input,button').length,title:document.title})",
      returnByValue: true,
    });
    if (result?.value?.title === "Computer Semantic MCP Test" && result?.value?.controls >= 2 && ["interactive", "complete"].includes(result?.value?.ready)) {
      loaded = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  socket.close();
  if (!loaded) throw new Error("CDP target did not finish loading the semantic fixture.");
  return {
    target,
    close: async () => {
      await fetch(`${cdpEndpoint}/json/close/${target.id}`, { method: "DELETE" }).catch(() => {});
    },
  };
}

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "computer-semantic-ci-smoke", version: "1.0.0" });
await client.connect(transport);

let launchedChromePid = null;
async function waitForCdp() {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${cdpEndpoint}/json/version`);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP endpoint ${cdpEndpoint} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

if (process.env.MCP_SMOKE_LAUNCH_CHROME === "1") {
  const profile = `/tmp/chatgpt-computer-semantic-chrome-${process.pid}`;
  const launch = await client.callTool({
    name: "run_shell_command",
    arguments: {
      command: `CHROME=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser); test -n "$CHROME"; rm -rf ${profile}; "$CHROME" --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=${new URL(cdpEndpoint).port || 9222} --remote-allow-origins=* --user-data-dir=${profile} --no-first-run --no-default-browser-check --window-position=0,0 --window-size=1100,720 about:blank >/tmp/chatgpt-computer-semantic-chrome.log 2>&1 & echo $!`,
      cwd: process.cwd(),
      timeoutSeconds: 10,
    },
  });
  assert.equal(launch.structuredContent.status, "completed", launch.structuredContent.stderr);
  launchedChromePid = Number(launch.structuredContent.stdout.trim().split(/\s+/).at(-1));
  await waitForCdp();
}

async function elements(args) {
  const result = await client.callTool({ name: "computer_elements", arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result.structuredContent;
}

async function waitForElements(args, predicate, description) {
  let latest = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await elements(args);
    if (predicate(latest.elements)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${description} did not become available. Last elements: ${JSON.stringify(latest?.elements?.map(({ index, role, name, value }) => ({ index, role, name, value })) ?? [])}`);
}

async function elementAction(snapshot, element, action, details = {}, expectedSettleSource = null) {
  const actionDetails = typeof details === "string" ? { value: details } : details;
  const result = await client.callTool({
    name: "computer_element_action",
    arguments: {
      snapshotId: snapshot.snapshotId,
      elementIndex: element.index,
      action,
      ...actionDetails,
      description: `semantic smoke ${action}`,
    },
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok(result.content.some((item) => item.type === "image"), `${action} should return a screenshot`);
  assert.ok(result.structuredContent.nextSnapshotId, `${action} should return a fresh semantic snapshot`);
  assert.equal(typeof result.structuredContent.stateText, "string", `${action} should return refreshed semantic state`);
  assert.equal(typeof result.structuredContent.settleDurationMs, "number", `${action} should report adaptive settle duration`);
  assert.equal(typeof result.structuredContent.settleEventCount, "number", `${action} should report native/browser event count`);
  assert.equal(typeof result.structuredContent.settleSource, "string", `${action} should report settle source`);
  if (expectedSettleSource) assert.equal(result.structuredContent.settleSource, expectedSettleSource);
  return result;
}

async function secondaryAction(snapshot, element, nativeAction) {
  const result = await client.callTool({
    name: "computer_element_secondary_action",
    arguments: { snapshotId: snapshot.snapshotId, elementIndex: element.index, nativeAction, description: "semantic smoke native action" },
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok(result.content.some((item) => item.type === "image"), "secondary action should return a screenshot");
  assert.equal(typeof result.structuredContent.settleSource, "string", "secondary action should report settle source");
  return result;
}

try {
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["computer_applications", "computer_app_state", "computer_browser_session", "computer_browser_utility", "computer_browser_locator", "computer_browser_cua", "computer_elements", "computer_element_action", "computer_element_secondary_action", "computer_use_bridge", "computer_window"]) assert.ok(names.has(name), `missing ${name}`);
  const applications = await client.callTool({ name: "computer_applications", arguments: {} });
  assert.equal(applications.isError, undefined, applications.content?.[0]?.text);
  assert.ok(Array.isArray(applications.structuredContent.applications));

  if (process.env.MCP_SMOKE_BROWSER_SESSION === "1") {
    const session = `ci-${process.pid}`;
    const fixtureServer = await startManagedBrowserFixture();
    const browserSession = (action, args = {}) => client.callTool({
      name: "computer_browser_session",
      arguments: { action, session, ...args },
    });
    const browserUtility = (action, args = {}) => client.callTool({
      name: "computer_browser_utility",
      arguments: { action, session, ...args },
    });
    const browserLocator = (target, steps) => client.callTool({
      name: "computer_browser_locator",
      arguments: { session, targetId: target.id, targetClaim: target.claim, steps },
    });
    const browserCua = (target, actions) => client.callTool({
      name: "computer_browser_cua",
      arguments: { session, targetId: target.id, targetClaim: target.claim, actions },
    });
    try {
      const started = await browserSession("start", { headless: true });
      assert.equal(started.isError, undefined, started.content?.[0]?.text);
      let currentTarget = started.structuredContent.session.targets.find((target) => !target.url.startsWith("chrome://"));
      assert.ok(currentTarget?.id && currentTarget?.claim, "isolated browser session should expose a claimed page target");
      const initialClaim = currentTarget.claim;

      const firstPage = `data:text/html,${encodeURIComponent("<title>isolated-one</title><h1>first</h1>")}`;
      const secondPage = `data:text/html,${encodeURIComponent("<title>isolated-two</title><h1>second</h1>")}`;
      for (const url of [firstPage, secondPage]) {
        const navigated = await browserSession("navigate", { targetId: currentTarget.id, targetClaim: currentTarget.claim, url });
        assert.equal(navigated.isError, undefined, navigated.content?.[0]?.text);
        assert.ok(navigated.content.some((item) => item.type === "image"), "isolated navigation should return a target-only screenshot");
        currentTarget = navigated.structuredContent.target;
      }
      const stale = await browserSession("screenshot", { targetId: currentTarget.id, targetClaim: initialClaim });
      assert.equal(stale.isError, true, "a pre-navigation target claim must fail closed");
      for (const action of ["back", "forward", "reload", "screenshot"]) {
        const result = await browserSession(action, { targetId: currentTarget.id, targetClaim: currentTarget.claim });
        assert.equal(result.isError, undefined, result.content?.[0]?.text);
        assert.ok(result.content.some((item) => item.type === "image"), `${action} should return a target-only screenshot`);
        currentTarget = result.structuredContent.target;
      }
      const utilityPage = await browserSession("navigate", { targetId: currentTarget.id, targetClaim: currentTarget.claim, url: `${fixtureServer.origin}/` });
      assert.equal(utilityPage.isError, undefined, utilityPage.content?.[0]?.text);
      currentTarget = utilityPage.structuredContent.target;
      const targetArgs = () => ({ targetId: currentTarget.id, targetClaim: currentTarget.claim });
      const exportedText = await browserUtility("export_text", targetArgs());
      assert.equal(exportedText.isError, undefined, exportedText.content?.[0]?.text);
      assert.match(exportedText.structuredContent.text, /utility-text-ok/);
      const exportedHtml = await browserUtility("export_html", targetArgs());
      assert.match(exportedHtml.structuredContent.text, /Managed utility export/);
      const exportedPdf = await browserUtility("export_pdf", { ...targetArgs(), filename: "browser-export.pdf", pdfOptions: { printBackground: true, preferCSSPageSize: true } });
      assert.equal(exportedPdf.isError, undefined, exportedPdf.content?.[0]?.text);
      const pdfArtifact = exportedPdf.structuredContent.artifacts[0];
      assert.equal(pdfArtifact?.kind, "pdf");
      assert.equal((await readFile(pdfArtifact.path)).subarray(0, 5).toString("ascii"), "%PDF-");
      const clipboardWrite = await browserUtility("clipboard_write", { ...targetArgs(), text: "managed-clipboard-ok" });
      assert.equal(clipboardWrite.isError, undefined, clipboardWrite.content?.[0]?.text);
      assert.equal(clipboardWrite.structuredContent.text, null, "clipboard writes must not echo their contents");
      const clipboardRead = await browserUtility("clipboard_read", targetArgs());
      assert.equal(clipboardRead.structuredContent.text, "managed-clipboard-ok");
      const logs = await browserUtility("logs", { ...targetArgs(), limit: 50 });
      assert.ok(logs.structuredContent.logs.some((entry) => entry.text.includes("managed-log-ok")), "managed target console log was not buffered");
      const locator = await browserLocator(currentTarget, [
        { action: "inspect", locator: { role: "textbox", name: "Locator input", exact: true } },
        { action: "fill", locator: { css: "#locator-input" }, value: "locator-" },
        { action: "press_key", locator: { css: "#locator-input" }, key: "End" },
        { action: "type", locator: { css: "#locator-input" }, value: "ok" },
        { action: "check", locator: { css: "#locator-check" } },
        { action: "select_option", locator: { role: "combobox", name: "Locator select", exact: true }, value: "two" },
        { action: "set_files", locator: { css: "#locator-file" }, files: [`${process.cwd()}/package.json`] },
        { action: "wait_for", locator: { css: "#upload-status", text: "package.json", exact: true }, state: "visible", timeoutMs: 5000 },
        { action: "set_files", locator: { css: "#locator-file" }, files: [pdfArtifact.path] },
        { action: "wait_for", locator: { css: "#upload-status", text: "browser-export.pdf", exact: true }, state: "visible", timeoutMs: 5000 },
        { action: "drag_to", locator: { css: "#drag-source" }, target: { css: "#drag-target" } },
        { action: "wait_for", locator: { css: "#drag-status", text: "drag-ok", exact: true }, state: "visible", timeoutMs: 5000 },
        { action: "fill", frames: [{ css: "#cross-frame" }], locator: { role: "textbox", name: "Frame input", exact: true }, value: "ok" },
        { action: "click", frames: [{ css: "#cross-frame" }], locator: { role: "button", name: "Run frame", exact: true } },
        { action: "wait_for", frames: [{ css: "#cross-frame" }], locator: { css: "#frame-status", text: "frame-ok", exact: true }, state: "visible", timeoutMs: 5000 },
        { action: "click", locator: { role: "button", name: "Open popup", exact: true } },
        { action: "click", locator: { role: "button", name: "Run locator", exact: true } },
        { action: "wait_for", locator: { css: "#locator-status", text: "locator-ok:true:two", exact: true }, state: "visible", timeoutMs: 5000 },
        { action: "get_attribute", locator: { text: "Run locator", exact: true }, attribute: "id" },
      ]);
      assert.equal(locator.isError, undefined, locator.content?.[0]?.text);
      assert.ok(locator.content.some((item) => item.type === "image"), "locator batch should return a target screenshot");
      assert.equal(locator.structuredContent.results[0].matched, true);
      assert.equal(locator.structuredContent.results.at(-1).value, "locator-run");
      const cua = await browserCua(currentTarget, [
        { action: "move", x: 40, y: 24 },
        { action: "click", x: 40, y: 24 },
      ]);
      assert.equal(cua.isError, undefined, cua.content?.[0]?.text);
      assert.equal(cua.structuredContent.actionCount, 2);
      assert.ok(cua.content.some((item) => item.type === "image"), "browser CUA should return a target-only screenshot");
      const cuaVisual = await browserCua(currentTarget, [
        { action: "double_click", x: 40, y: 24 },
        { action: "scroll", x: 40, y: 24, scrollX: 0, scrollY: 80 },
        { action: "screenshot", clip: { x: 0, y: 0, width: 240, height: 120 } },
      ]);
      assert.equal(cuaVisual.isError, undefined, cuaVisual.content?.[0]?.text);
      assert.equal(cuaVisual.structuredContent.actionCount, 3);
      assert.ok(cuaVisual.content.some((item) => item.type === "image"), "clipped browser CUA should return a screenshot");
      const cuaWait = await browserLocator(currentTarget, [
        { action: "wait_for", locator: { css: "#cua-status", text: "cua-ok", exact: true }, state: "visible", timeoutMs: 5000 },
      ]);
      assert.equal(cuaWait.isError, undefined, cuaWait.content?.[0]?.text);
      let popup = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const listed = await browserSession("list");
        const listedSession = listed.structuredContent.sessions.find((item) => item.name === session);
        popup = listedSession?.targets.find((target) => target.url === `${fixtureServer.origin}/popup`) ?? null;
        if (popup) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(popup?.owner, "automation", "popup opened by an automation tab should inherit automation ownership");
      assert.equal(popup?.retained, false);

      const dialogPage = await browserSession("navigate", { ...targetArgs(), url: `${fixtureServer.origin}/dialog` });
      currentTarget = dialogPage.structuredContent.target;
      let dialog = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        dialog = await browserUtility("dialog_state", targetArgs());
        if (dialog.structuredContent.dialog) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(dialog.structuredContent.dialog?.message, "managed-dialog-ok");
      const dismissed = await browserUtility("dialog_dismiss", targetArgs());
      assert.equal(dismissed.isError, undefined, dismissed.content?.[0]?.text);

      const downloadPage = await browserSession("navigate", { ...targetArgs(), url: `${fixtureServer.origin}/download-page` });
      currentTarget = downloadPage.structuredContent.target;
      let downloadGuid = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const downloads = await browserUtility("downloads");
        downloadGuid = downloads.structuredContent.downloads[0]?.guid ?? "";
        if (downloadGuid) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(downloadGuid, "managed browser download event was not observed");
      const download = await browserUtility("download_wait", { downloadGuid, timeoutMs: 10_000 });
      assert.equal(download.structuredContent.downloads.find((item) => item.guid === downloadGuid)?.state, "completed");
      assert.ok(download.structuredContent.files.some((file) => file.name === "computer-browser-ci.txt"));
      const created = await browserSession("new_tab", { url: "about:blank" });
      assert.equal(created.isError, undefined, created.content?.[0]?.text);
      assert.ok(created.structuredContent.target?.id);
      assert.equal(created.structuredContent.target.owner, "automation");
      assert.equal(created.structuredContent.target.retained, false);
      const activated = await browserSession("activate_tab", { targetId: created.structuredContent.target.id, targetClaim: created.structuredContent.target.claim });
      assert.equal(activated.isError, undefined, activated.content?.[0]?.text);
      const retained = await browserSession("retain_tab", { targetId: activated.structuredContent.target.id, targetClaim: activated.structuredContent.target.claim });
      assert.equal(retained.structuredContent.target.retained, true);
      const disposable = await browserSession("new_tab", { url: "about:blank" });
      const cleaned = await browserSession("cleanup_tabs");
      assert.ok(cleaned.structuredContent.session.targets.some((target) => target.id === retained.structuredContent.target.id), "retained automation tab should survive cleanup");
      assert.ok(!cleaned.structuredContent.session.targets.some((target) => target.id === disposable.structuredContent.target.id), "temporary automation tab should be cleaned up");
      const retainedAfterCleanup = cleaned.structuredContent.session.targets.find((target) => target.id === retained.structuredContent.target.id);
      const released = await browserSession("release_tab", { targetId: retainedAfterCleanup.id, targetClaim: retainedAfterCleanup.claim });
      assert.equal(released.structuredContent.target.retained, false);
      const finalCleanup = await browserSession("cleanup_tabs");
      assert.ok(!finalCleanup.structuredContent.session.targets.some((target) => target.id === released.structuredContent.target.id));
      console.log("Isolated browser session lifecycle smoke passed.");
    } finally {
      await browserSession("stop").catch(() => {});
      await fixtureServer.close();
    }
  }

  const fixture = await createBrowserFixture();
  try {
    const listedBrowsers = await client.callTool({ name: "computer_browser_session", arguments: { action: "list" } });
    assert.equal(listedBrowsers.isError, undefined, listedBrowsers.content?.[0]?.text);
    const attachedSession = listedBrowsers.structuredContent.sessions.find((item) => item.kind === "attached" && item.endpoint === cdpEndpoint);
    assert.ok(attachedSession, "configured existing CDP browser was not exposed as an attached session");
    const attachedTarget = attachedSession.targets.find((item) => item.id === fixture.target.id);
    assert.ok(attachedTarget?.claim, "attached browser target did not receive an exact claim");
    const attachedExport = await client.callTool({
      name: "computer_browser_utility",
      arguments: { action: "export_text", session: attachedSession.name, targetId: attachedTarget.id, targetClaim: attachedTarget.claim },
    });
    assert.equal(attachedExport.isError, undefined, attachedExport.content?.[0]?.text);
    assert.match(attachedExport.structuredContent.text, /Run semantic test/);
    const attachedLocator = await client.callTool({
      name: "computer_browser_locator",
      arguments: {
        session: attachedSession.name, targetId: attachedTarget.id, targetClaim: attachedTarget.claim,
        steps: [{ action: "inspect", locator: { role: "textbox", name: "Semantic name", exact: true } }],
      },
    });
    assert.equal(attachedLocator.isError, undefined, attachedLocator.content?.[0]?.text);
    assert.equal(attachedLocator.structuredContent.results[0].matched, true);
    assert.ok(attachedLocator.content.some((item) => item.type === "image"), "attached locator should return a page screenshot");
    const refusedStop = await client.callTool({ name: "computer_browser_session", arguments: { action: "stop", session: attachedSession.name } });
    assert.equal(refusedStop.isError, true, "attached browsers must never be stopped by the session tool");

    let snapshot = await waitForElements(
      { source: "browser", targetId: fixture.target.id, includeStaticText: true, maxElements: 40 },
      (items) => items.some((element) => element.role === "textbox" && element.name.includes("Semantic name")),
      "Browser semantic controls",
    );
    const field = snapshot.elements.find((element) => element.role === "textbox" && element.name.includes("Semantic name"));
    const button = snapshot.elements.find((element) => element.role === "button" && element.name.includes("Run semantic test"));
    assert.ok(field, "browser semantic textbox not found");
    assert.ok(button, "browser semantic button not found");
    assert.equal(field.identifier, "name");
    assert.ok(Number.isInteger(field.depth));
    await elementAction(snapshot, field, "set_value", "semantic-browser-ok");

    snapshot = await elements({ source: "browser", targetId: fixture.target.id, includeStaticText: true, maxElements: 40 });
    const refreshedField = snapshot.elements.find((element) => element.role === "textbox" && element.name.includes("Semantic name"));
    assert.ok(refreshedField);
    await elementAction(snapshot, refreshedField, "select_text", { text: "browser", prefix: "semantic-", suffix: "-ok", selectionType: "text" });

    snapshot = await elements({ source: "browser", targetId: fixture.target.id, includeStaticText: true, maxElements: 40 });
    const refreshedButton = snapshot.elements.find((element) => element.role === "button" && element.name.includes("Run semantic test"));
    assert.ok(refreshedButton);
    await elementAction(snapshot, refreshedButton, "click", { button: "left", count: 1 });

    snapshot = await elements({ source: "browser", targetId: fixture.target.id, includeStaticText: true, maxElements: 40 });
    assert.ok(snapshot.elements.some((element) => `${element.name} ${element.value}`.includes("clicked:semantic-browser-ok")), "browser semantic action result not observed");
    console.log("Browser CDP semantic MCP smoke passed.");
  } finally {
    await fixture.close();
  }

  if (process.env.MCP_SMOKE_ATSPI === "1") {
    const launch = await client.callTool({
      name: "run_shell_command",
      arguments: {
        command: "python3 scripts/fixtures/atspi-test-app.py >/tmp/chatgpt-computer-atspi-test.log 2>&1 & echo $!",
        cwd: process.cwd(),
        timeoutSeconds: 10,
      },
    });
    assert.equal(launch.structuredContent.status, "completed", launch.structuredContent.stderr);
    const pid = Number(launch.structuredContent.stdout.trim().split(/\s+/).at(-1));
    try {
      let snapshot = await waitForElements(
        { source: "desktop", application: "chatgpt-computer-semantic-test", includeStaticText: true, maxElements: 80 },
        (items) =>
          items.some((element) => ["entry", "text"].includes(element.role) && element.name.includes("Semantic entry")) &&
          items.some((element) => element.role === "button" && element.name.includes("Apply semantic value")),
        "AT-SPI semantic controls",
      );
      const field = snapshot.elements.find((element) => ["entry", "text"].includes(element.role) && element.name.includes("Semantic entry"));
      const button = snapshot.elements.find((element) => element.role === "button" && element.name.includes("Apply semantic value"));
      assert.ok(field, `AT-SPI semantic entry not found: ${JSON.stringify(snapshot.applications)}`);
      assert.ok(button, "AT-SPI semantic button not found");
      assert.equal(snapshot.applicationId, "atspi:chatgpt-computer-semantic-test");
      assert.ok(Number.isInteger(button.depth));
      const applicationState = await client.callTool({
        name: "computer_app_state",
        arguments: { app: "atspi:chatgpt-computer-semantic-test", disableDiff: true, maxElements: 80 },
      });
      assert.equal(applicationState.isError, undefined, applicationState.content?.[0]?.text);
      assert.equal(applicationState.structuredContent.screenshotScope, "application");
      assert.ok(applicationState.structuredContent.screenshotBounds?.width > 0);
      assert.ok(applicationState.content.some((item) => item.type === "image"), "application state should return a scoped screenshot");

      const bridgeApps = await client.callTool({ name: "computer_use_bridge", arguments: { operation: "list_apps" } });
      assert.equal(bridgeApps.isError, undefined, bridgeApps.content?.[0]?.text);
      assert.ok(bridgeApps.structuredContent.applications.some((application) => application.id === "atspi:chatgpt-computer-semantic-test"));
      const bridgeState = await client.callTool({
        name: "computer_use_bridge",
        arguments: { operation: "get_app_state", app: "atspi:chatgpt-computer-semantic-test", disableDiff: true },
      });
      assert.equal(bridgeState.isError, undefined, bridgeState.content?.[0]?.text);
      assert.equal(bridgeState.structuredContent.screenshotScope, "application");
      assert.ok(bridgeState.structuredContent.snapshotId);
      const bridgeFieldLine = bridgeState.structuredContent.text.split("\n").find((line) => /\b(?:entry|text)\b.*Semantic entry/i.test(line));
      const bridgeFieldIndex = Number(/^\s*(\d+)/.exec(bridgeFieldLine ?? "")?.[1]);
      assert.ok(Number.isInteger(bridgeFieldIndex), `bridge field index missing from ${bridgeState.structuredContent.text}`);
      const bridgeSetValue = await client.callTool({
        name: "computer_use_bridge",
        arguments: { operation: "set_value", app: "atspi:chatgpt-computer-semantic-test", snapshot_id: bridgeState.structuredContent.snapshotId, element_index: bridgeFieldIndex, value: "bridge-atspi-ok" },
      });
      assert.equal(bridgeSetValue.isError, undefined, bridgeSetValue.content?.[0]?.text);
      assert.ok(bridgeSetValue.structuredContent.snapshotId, "bridge write should return replacement state");
      const bridgeBounds = bridgeSetValue.structuredContent.screenshotBounds;
      assert.ok(bridgeBounds?.width > 0 && button.bounds?.width > 0, "bridge coordinate test requires app and button bounds");
      const localButtonX = button.bounds.x - bridgeBounds.x + button.bounds.width / 2;
      const localButtonY = button.bounds.y - bridgeBounds.y + button.bounds.height / 2;
      const bridgeClick = await client.callTool({
        name: "computer_use_bridge",
        arguments: { operation: "click", app: "atspi:chatgpt-computer-semantic-test", snapshot_id: bridgeSetValue.structuredContent.snapshotId, x: localButtonX, y: localButtonY, mouse_button: "left", click_count: 1 },
      });
      assert.equal(bridgeClick.isError, undefined, bridgeClick.content?.[0]?.text);
      assert.match(bridgeClick.structuredContent.text, /clicked:bridge-atspi-ok/);
      console.log("Computer Use-compatible remote bridge smoke passed.");

      const desktopState = await client.callTool({ name: "computer_state", arguments: { includeScreenshot: false, includeWindows: true } });
      const testWindow = desktopState.structuredContent.windows.find((window) => /ChatGPT Computer Semantic Test/i.test(window.name));
      assert.ok(testWindow?.id, `AT-SPI test window was not listed: ${JSON.stringify(desktopState.structuredContent.windows)}`);
      for (const [windowAction, geometry] of [
        ["activate", {}], ["minimize", {}], ["restore", {}], ["maximize", {}], ["restore", {}],
        ["move_resize", { x: 40, y: 40, width: 800, height: 500 }],
      ]) {
        const controlled = await client.callTool({
          name: "computer_window",
          arguments: { windowId: testWindow.id, windowClaim: testWindow.claim, action: windowAction, ...geometry },
        });
        assert.equal(controlled.isError, undefined, controlled.content?.[0]?.text);
        assert.ok(controlled.content.some((item) => item.type === "image"), `${windowAction} should return a desktop screenshot`);
      }
      const setValueResult = await elementAction(snapshot, field, "set_value", "semantic-atspi-ok", "linux-atspi-service");
      assert.equal(setValueResult.structuredContent.screenshotScope, "application");
      assert.ok(setValueResult.structuredContent.screenshotBounds?.width > 0);

      snapshot = await elements({ source: "desktop", application: "chatgpt-computer-semantic-test", includeStaticText: true, maxElements: 80 });
      const refreshedField = snapshot.elements.find((element) => ["entry", "text"].includes(element.role) && element.name.includes("Semantic entry"));
      assert.ok(refreshedField);
      await elementAction(snapshot, refreshedField, "select_text", { text: "atspi", prefix: "semantic-", suffix: "-ok", selectionType: "text" });

      snapshot = await elements({ source: "desktop", application: "chatgpt-computer-semantic-test", includeStaticText: true, maxElements: 80 });
      const refreshedButton = snapshot.elements.find((element) => element.role === "button" && element.name.includes("Apply semantic value"));
      assert.ok(refreshedButton);
      const nativeAction = refreshedButton.nativeActions.find((name) => /click|press|activate/i.test(name));
      assert.ok(nativeAction, `AT-SPI button did not advertise a native action: ${JSON.stringify(refreshedButton.nativeActions)}`);
      await secondaryAction(snapshot, refreshedButton, nativeAction);

      snapshot = await elements({ source: "desktop", application: "chatgpt-computer-semantic-test", includeStaticText: true, maxElements: 80 });
      assert.ok(snapshot.elements.some((element) => `${element.name} ${element.value}`.includes("clicked:semantic-atspi-ok")), "AT-SPI semantic action result not observed");
      console.log("Linux AT-SPI semantic MCP smoke passed.");
    } finally {
      if (Number.isInteger(pid) && pid > 1) {
        await client.callTool({ name: "run_shell_command", arguments: { command: `kill ${pid} 2>/dev/null || true`, timeoutSeconds: 5 } }).catch(() => {});
      }
    }
  }
} finally {
  if (Number.isInteger(launchedChromePid) && launchedChromePid > 1) {
    await client.callTool({ name: "run_shell_command", arguments: { command: `kill ${launchedChromePid} 2>/dev/null || true; pkill -f chatgpt-computer-semantic-chrome-${process.pid} 2>/dev/null || true`, timeoutSeconds: 5 } }).catch(() => {});
  }
  await client.close();
}
