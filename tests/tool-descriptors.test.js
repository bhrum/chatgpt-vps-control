import test from "node:test";
import assert from "node:assert/strict";
import { buildComputerToolDescriptors } from "../computer-use.js";

test("computer tools advertise cross-platform read/write capabilities", () => {
  const read = [{ type: "oauth2", scopes: ["vps.read"] }];
  const write = [{ type: "oauth2", scopes: ["vps.write"] }];
  const tools = buildComputerToolDescriptors({ readSecuritySchemes: read, writeSecuritySchemes: write, toolMeta: () => ({}) });
  assert.deepEqual(tools.map((tool) => tool.name), ["computer_environment", "computer_state", "computer_use"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.readOnlyHint, false);
  assert.match(tools[1].description, /local computer/i);
  assert.match(tools[1].description, /macOS/i);
  assert.match(tools[2].description, /platform-native/i);
});
