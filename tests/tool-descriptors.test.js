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
    "computer_browser_session",
    "computer_browser_utility",
    "computer_browser_locator",
    "computer_elements",
    "computer_element_action",
    "computer_element_secondary_action",
    "computer_state",
    "computer_window",
    "computer_use",
    "computer_browser_cua",
  ]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.readOnlyHint, false);
  assert.equal(tools[3].annotations.readOnlyHint, false);
  assert.equal(tools[4].annotations.readOnlyHint, false);
  assert.equal(tools[5].annotations.readOnlyHint, false);
  assert.equal(tools[6].annotations.readOnlyHint, true);
  assert.equal(tools[7].annotations.readOnlyHint, false);
  assert.equal(tools[8].annotations.readOnlyHint, false);
  assert.equal(tools[9].annotations.readOnlyHint, true);
  assert.equal(tools[10].annotations.readOnlyHint, false);
  assert.equal(tools[11].annotations.readOnlyHint, false);
  assert.deepEqual(tools[2].securitySchemes, write);
  assert.deepEqual(tools[3].securitySchemes, write);
  assert.match(tools[1].description, /platform identifiers/i);
  assert.match(tools[1].description, /recent-use metadata/i);
  assert.ok(tools[1].outputSchema.properties.applications.items.required.includes("lastUsedDate"));
  assert.ok(tools[1].outputSchema.properties.applications.items.required.includes("useCount"));
  assert.match(tools[2].description, /compact diff/i);
  assert.match(tools[2].description, /without taking foreground focus/i);
  assert.ok(tools[2].inputSchema.properties.query);
  assert.equal(tools[2].inputSchema.properties.maxDepth.maximum, 40);
  assert.equal(tools[2].inputSchema.properties.maxVisitedNodes.maximum, 20000);
  assert.equal(tools[2].inputSchema.properties.focusedWindowOnly.default, true);
  assert.equal(tools[2].inputSchema.properties.activate.default, false);
  assert.ok(tools[2].outputSchema.properties.screenshotIncluded);
  assert.ok(tools[2].outputSchema.properties.screenshotScope);
  assert.ok(tools[2].outputSchema.properties.screenshotBounds);
  assert.match(tools[3].description, /loopback-only DevTools/i);
  assert.match(tools[3].description, /ordinary browser windows/i);
  assert.deepEqual(tools[3].inputSchema.properties.action.enum, [
    "list", "start", "navigate", "new_tab", "activate_tab", "back", "forward", "reload", "screenshot", "retain_tab", "release_tab", "cleanup_tabs", "close_tab", "stop",
  ]);
  assert.ok(tools[3].outputSchema.properties.screenshotIncluded);
  assert.ok(tools[3].inputSchema.properties.targetClaim);
  assert.ok(tools[3].outputSchema.properties.session.anyOf[0].properties.targets.items.required.includes("claim"));
  assert.ok(tools[3].outputSchema.properties.session.anyOf[0].properties.targets.items.required.includes("owner"));
  assert.ok(tools[3].outputSchema.properties.session.anyOf[0].properties.targets.items.required.includes("retained"));
  assert.match(tools[4].description, /clipboard access/i);
  assert.deepEqual(tools[4].inputSchema.properties.action.enum, [
    "export_html", "export_text", "export_pdf", "clipboard_read", "clipboard_write", "logs", "dialog_state", "dialog_accept", "dialog_dismiss", "downloads", "download_wait", "download_cancel",
  ]);
  assert.ok(tools[4].outputSchema.properties.downloads);
  assert.ok(tools[4].outputSchema.properties.artifacts);
  assert.ok(tools[4].inputSchema.properties.pdfOptions);
  assert.ok(tools[4].inputSchema.properties.targetClaim);
  assert.match(tools[5].description, /arbitrary JavaScript evaluation is not exposed/i);
  assert.deepEqual(tools[5].inputSchema.properties.steps.items.properties.action.enum, [
    "inspect", "wait_for", "click", "double_click", "hover", "focus", "fill", "type", "check", "uncheck", "select_option", "set_files", "drag_to", "press_key", "scroll_into_view", "scroll", "get_attribute",
  ]);
  assert.equal(tools[5].inputSchema.properties.steps.items.properties.files.maxItems, 20);
  assert.equal(tools[5].inputSchema.properties.steps.items.properties.frames.maxItems, 8);
  assert.equal(tools[5].inputSchema.properties.steps.items.properties.target.additionalProperties, false);
  assert.ok(tools[5].inputSchema.properties.targetClaim);
  assert.match(tools[6].description, /semantic accessibility tree/i);
  assert.ok(tools[6].inputSchema.properties.includeContainers);
  assert.ok(tools[6].inputSchema.properties.maxDepth);
  assert.ok(tools[6].inputSchema.properties.maxVisitedNodes);
  assert.ok(tools[6].inputSchema.properties.focusedWindowOnly);
  assert.ok(tools[6].outputSchema.properties.elements.items.properties.nativeActions);
  assert.match(tools[7].description, /snapshot/i);
  assert.deepEqual(tools[7].inputSchema.properties.action.enum, [
    "press", "click", "focus", "set_value", "select_text", "toggle", "increment", "decrement", "scroll_into_view", "scroll",
  ]);
  assert.ok(tools[7].inputSchema.properties.selectionType);
  assert.ok(tools[7].inputSchema.properties.button);
  assert.ok(tools[7].inputSchema.properties.pages);
  assert.ok(tools[7].inputSchema.properties.returnState);
  assert.ok(tools[7].outputSchema.properties.settleDurationMs);
  assert.ok(tools[7].outputSchema.properties.settleEventCount);
  assert.ok(tools[7].outputSchema.properties.settleSource);
  assert.ok(tools[7].outputSchema.properties.screenshotScope);
  assert.ok(tools[7].outputSchema.properties.screenshotBounds);
  assert.match(tools[8].description, /native accessibility action/i);
  assert.ok(tools[8].inputSchema.properties.returnState);
  assert.ok(tools[8].outputSchema.properties.screenshotScope);
  assert.match(tools[9].description, /local computer/i);
  assert.match(tools[9].description, /macOS/i);
  assert.match(tools[10].description, /activate.*close.*minimize.*maximize.*restore/i);
  assert.deepEqual(tools[10].inputSchema.properties.action.enum, ["activate", "close", "minimize", "maximize", "restore", "move_resize"]);
  assert.ok(tools[10].inputSchema.required.includes("windowClaim"));
  assert.ok(tools[9].outputSchema.properties.windows.items.required.includes("claim"));
  assert.ok(tools[10].outputSchema.properties.windows);
  assert.ok(tools[10].outputSchema.properties.screenshotIncluded);
  assert.match(tools[11].description, /platform-native/i);
  assert.match(tools[11].description, /locked.*secure desktops/i);
  assert.ok(tools[11].inputSchema.properties.application);
  assert.equal(tools[11].inputSchema.properties.activateApplication.default, false);
  assert.match(tools[12].description, /page CSS-pixel coordinates/i);
  assert.match(tools[12].description, /separate from desktop/i);
  assert.deepEqual(tools[12].inputSchema.properties.actions.items.properties.action.enum, [
    "screenshot", "click", "double_click", "move", "drag", "type", "key", "keypress", "scroll", "download_media", "wait",
  ]);
  assert.equal(tools[12].inputSchema.properties.actions.maxItems, 20);
  assert.ok(tools[12].inputSchema.properties.targetClaim);
  assert.ok(tools[12].inputSchema.properties.actions.items.properties.path);
  assert.ok(tools[12].inputSchema.properties.actions.items.properties.clip);
  assert.ok(tools[12].inputSchema.properties.actions.items.properties.scrollX);
  assert.ok(tools[12].inputSchema.properties.actions.items.properties.keypress);
  assert.ok(tools[12].outputSchema.properties.screenshotIncluded);
});

test("device gateway exposes a stable dynamic-device tool surface", () => {
  const read = [{ type: "oauth2", scopes: ["vps.read"] }];
  const write = [{ type: "oauth2", scopes: ["vps.write"] }];
  const tools = buildDeviceToolDescriptors({ readSecuritySchemes: read, writeSecuritySchemes: write });
  assert.deepEqual(tools.map((tool) => tool.name), ["list_devices", "describe_device_tool", "device_call"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.destructiveHint, true);
  assert.deepEqual(tools[0].securitySchemes, read);
  assert.deepEqual(tools[1].securitySchemes, read);
  assert.deepEqual(tools[2].securitySchemes, write);
  assert.ok(tools[0].outputSchema.properties.devices.items.properties.toolSchemaCount);
  assert.ok(tools[0].outputSchema.properties.devices.items.properties.toolSchemaVersion);
  assert.ok(tools[1].inputSchema.properties.deviceId);
  assert.ok(tools[1].inputSchema.properties.toolName);
  assert.ok(tools[1].outputSchema.properties.tool);
  assert.ok(tools[2].inputSchema.properties.deviceId);
  assert.ok(tools[2].inputSchema.properties.argumentsJson);
  assert.match(tools[2].description, /describe_device_tool/);
});
