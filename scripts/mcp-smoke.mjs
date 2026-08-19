import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.env.MCP_SMOKE_TOKEN;
const port = Number(process.env.MCP_SMOKE_PORT || 18995);
if (!token) throw new Error("MCP_SMOKE_TOKEN is required.");

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "computer-control-ci-smoke", version: "1.0.0" });
await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["computer_environment", "computer_elements", "computer_element_action", "computer_state", "computer_window", "computer_use", "run_shell_command", "file_info"]) {
    assert.ok(names.has(name), `missing MCP tool: ${name}`);
  }

  const environment = await client.callTool({ name: "computer_environment", arguments: {} });
  assert.equal(environment.structuredContent.ready, true);
  assert.equal(environment.structuredContent.backend, "linux-x11");
  assert.equal(environment.structuredContent.permissions.interactiveDesktop, true);
  assert.equal(environment.structuredContent.permissions.screenLocked, false);

  const state = await client.callTool({ name: "computer_state", arguments: { includeScreenshot: true, includeWindows: false } });
  assert.equal(state.structuredContent.apiResolution.width, 1280);
  assert.ok(state.content.some((item) => item.type === "image"), "computer_state should return a screenshot");

  const before = state.structuredContent.cursorPosition ?? { x: 10, y: 10 };
  const move = await client.callTool({
    name: "computer_use",
    arguments: {
      action: "move",
      x: Math.max(0, Math.min(1279, before.x + 1)),
      y: before.y,
      description: "CI smoke-test cursor movement",
    },
  });
  assert.equal(move.structuredContent.actionCount, 1);
  assert.ok(move.content.some((item) => item.type === "image"), "computer_use should return a screenshot");

  console.log("MCP managed-desktop smoke test passed.");
} finally {
  await client.close();
}
