import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

const token = process.env.MCP_SMOKE_TOKEN;
const port = Number(process.env.MCP_SMOKE_PORT || 18995);
const cdpEndpoint = (process.env.MCP_SMOKE_CDP_ENDPOINT || "http://127.0.0.1:9222").replace(/\/$/, "");
if (!token) throw new Error("MCP_SMOKE_TOKEN is required.");


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

async function elementAction(snapshot, element, action, value) {
  const result = await client.callTool({
    name: "computer_element_action",
    arguments: {
      snapshotId: snapshot.snapshotId,
      elementIndex: element.index,
      action,
      ...(value === undefined ? {} : { value }),
      description: `semantic smoke ${action}`,
    },
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok(result.content.some((item) => item.type === "image"), `${action} should return a screenshot`);
  return result;
}

try {
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["computer_elements", "computer_element_action"]) assert.ok(names.has(name), `missing ${name}`);

  const fixture = await createBrowserFixture();
  try {
    let snapshot = await waitForElements(
      { source: "browser", targetId: fixture.target.id, includeStaticText: true, maxElements: 40 },
      (items) => items.some((element) => element.role === "textbox" && element.name.includes("Semantic name")),
      "Browser semantic controls",
    );
    const field = snapshot.elements.find((element) => element.role === "textbox" && element.name.includes("Semantic name"));
    const button = snapshot.elements.find((element) => element.role === "button" && element.name.includes("Run semantic test"));
    assert.ok(field, "browser semantic textbox not found");
    assert.ok(button, "browser semantic button not found");
    await elementAction(snapshot, field, "set_value", "semantic-browser-ok");

    snapshot = await elements({ source: "browser", targetId: fixture.target.id, includeStaticText: true, maxElements: 40 });
    const refreshedButton = snapshot.elements.find((element) => element.role === "button" && element.name.includes("Run semantic test"));
    assert.ok(refreshedButton);
    await elementAction(snapshot, refreshedButton, "press");

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
      await elementAction(snapshot, field, "set_value", "semantic-atspi-ok");

      snapshot = await elements({ source: "desktop", application: "chatgpt-computer-semantic-test", includeStaticText: true, maxElements: 80 });
      const refreshedButton = snapshot.elements.find((element) => element.role === "button" && element.name.includes("Apply semantic value"));
      assert.ok(refreshedButton);
      await elementAction(snapshot, refreshedButton, "press");

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
