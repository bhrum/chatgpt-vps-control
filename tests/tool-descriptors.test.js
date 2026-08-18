import test from "node:test";
import assert from "node:assert/strict";
import { buildComputerToolDescriptors } from "../computer-use.js";
import { buildDeviceToolDescriptors } from "../lib/device-gateway.js";

test("computer tools advertise cross-platform read/write capabilities", () => {
  const read = [{ type: "oauth2", scopes: ["vps.read"] }];
  const write = [{ type: "oauth2", scopes: ["vps.write"] }];
  const tools = buildComputerToolDescriptors({ readSecuritySchemes: read, writeSecuritySchemes: write, toolMeta: () => ({}) });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "computer_environment",
    "computer_applications",
    "computer_app_state",
    "computer_elements",
    "computer_element_action",
    "computer_element_secondary_action",
    "computer_state",
    "computer_use",
  ]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.readOnlyHint, false);
  assert.equal(tools[3].annotations.readOnlyHint, true);
  assert.equal(tools[4].annotations.readOnlyHint, false);
  assert.equal(tools[5].annotations.readOnlyHint, false);
  assert.equal(tools[6].annotations.readOnlyHint, true);
  assert.equal(tools[7].annotations.readOnlyHint, false);
  assert.deepEqual(tools[2].securitySchemes, write);
  assert.match(tools[1].description, /platform identifiers/i);
  assert.match(tools[2].description, /compact diff/i);
  assert.match(tools[2].description, /launch or activate/i);
  assert.match(tools[3].description, /semantic accessibility tree/i);
  assert.ok(tools[3].inputSchema.properties.includeContainers);
  assert.ok(tools[3].outputSchema.properties.elements.items.properties.nativeActions);
  assert.match(tools[4].description, /snapshot/i);
  assert.match(tools[5].description, /native accessibility action/i);
  assert.match(tools[6].description, /local computer/i);
  assert.match(tools[6].description, /macOS/i);
  assert.match(tools[7].description, /platform-native/i);
  assert.ok(tools[7].inputSchema.properties.application);
});

test("device gateway exposes a stable dynamic-device tool surface", () => {
  const read = [{ type: "oauth2", scopes: ["vps.read"] }];
  const write = [{ type: "oauth2", scopes: ["vps.write"] }];
  const tools = buildDeviceToolDescriptors({ readSecuritySchemes: read, writeSecuritySchemes: write });
  assert.deepEqual(tools.map((tool) => tool.name), ["list_devices", "device_call"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.destructiveHint, true);
  assert.deepEqual(tools[0].securitySchemes, read);
  assert.deepEqual(tools[1].securitySchemes, write);
  assert.ok(tools[1].inputSchema.properties.deviceId);
  assert.ok(tools[1].inputSchema.properties.argumentsJson);
});
