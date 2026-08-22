import test from "node:test";
import assert from "node:assert/strict";
import { buildComputerToolDescriptors, pruneComputerUseBridgeElements } from "../computer-use.js";
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
    "computer_browser_snapshot",
    "computer_browser_locator",
    "computer_elements",
    "computer_element_action",
    "computer_element_secondary_action",
    "computer_state",
    "computer_window",
    "computer_use",
    "computer_use_bridge",
    "computer_browser_cua",
  ]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.readOnlyHint, false);
  assert.equal(tools[3].annotations.readOnlyHint, false);
  assert.equal(tools[4].annotations.readOnlyHint, false);
  assert.equal(tools[5].annotations.readOnlyHint, true);
  assert.equal(tools[6].annotations.readOnlyHint, false);
  assert.equal(tools[7].annotations.readOnlyHint, true);
  assert.equal(tools[8].annotations.readOnlyHint, false);
  assert.equal(tools[9].annotations.readOnlyHint, false);
  assert.equal(tools[10].annotations.readOnlyHint, true);
  assert.equal(tools[11].annotations.readOnlyHint, false);
  assert.equal(tools[12].annotations.readOnlyHint, false);
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
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const snapshot = byName.computer_browser_snapshot;
  const locator = byName.computer_browser_locator;
  const elements = byName.computer_elements;
  const elementAction = byName.computer_element_action;
  const secondaryAction = byName.computer_element_secondary_action;
  const state = byName.computer_state;
  const window = byName.computer_window;
  const use = byName.computer_use;
  const bridge = byName.computer_use_bridge;
  const cua = byName.computer_browser_cua;
  assert.equal(snapshot.annotations.readOnlyHint, true);
  assert.ok(snapshot.outputSchema.properties.snapshotId);
  assert.ok(snapshot.outputSchema.properties.refs);
  assert.match(snapshot.description, /short-lived @refs/i);
  assert.match(locator.description, /arbitrary JavaScript evaluation is not exposed/i);
  assert.ok(locator.inputSchema.properties.steps.items.properties.locator.properties.ref);
  assert.ok(locator.inputSchema.properties.steps.items.properties.locator.properties.snapshotId);
  assert.deepEqual(locator.inputSchema.properties.steps.items.properties.action.enum, [
    "inspect", "wait_for", "click", "double_click", "hover", "focus", "fill", "type", "check", "uncheck", "select_option", "set_files", "drag_to", "press_key", "scroll_into_view", "scroll", "get_attribute",
  ]);
  assert.equal(locator.inputSchema.properties.steps.items.properties.files.maxItems, 20);
  assert.equal(locator.inputSchema.properties.steps.items.properties.frames.maxItems, 8);
  assert.equal(locator.inputSchema.properties.steps.items.properties.target.additionalProperties, false);
  assert.ok(locator.inputSchema.properties.targetClaim);
  assert.match(elements.description, /semantic accessibility tree/i);
  assert.ok(elements.inputSchema.properties.includeContainers);
  assert.ok(elements.inputSchema.properties.maxDepth);
  assert.ok(elements.inputSchema.properties.maxVisitedNodes);
  assert.ok(elements.inputSchema.properties.focusedWindowOnly);
  assert.ok(elements.outputSchema.properties.elements.items.properties.nativeActions);
  assert.match(elementAction.description, /snapshot/i);
  assert.deepEqual(elementAction.inputSchema.properties.action.enum, [
    "press", "click", "focus", "set_value", "select_text", "toggle", "increment", "decrement", "scroll_into_view", "scroll",
  ]);
  for (const property of ["selectionType", "button", "pages", "returnState"]) assert.ok(elementAction.inputSchema.properties[property]);
  for (const property of ["settleDurationMs", "settleEventCount", "settleSource", "screenshotScope", "screenshotBounds"]) assert.ok(elementAction.outputSchema.properties[property]);
  assert.match(secondaryAction.description, /native accessibility action/i);
  assert.ok(secondaryAction.inputSchema.properties.returnState);
  assert.ok(secondaryAction.outputSchema.properties.screenshotScope);
  assert.match(state.description, /local computer/i);
  assert.match(state.description, /macOS/i);
  assert.match(window.description, /activate.*close.*minimize.*maximize.*restore/i);
  assert.deepEqual(window.inputSchema.properties.action.enum, ["activate", "close", "minimize", "maximize", "restore", "move_resize"]);
  assert.ok(window.inputSchema.required.includes("windowClaim"));
  assert.ok(state.outputSchema.properties.windows.items.required.includes("claim"));
  assert.ok(window.outputSchema.properties.windows);
  assert.ok(window.outputSchema.properties.screenshotIncluded);
  assert.match(use.description, /platform-native/i);
  assert.match(use.description, /locked.*secure desktops/i);
  assert.ok(use.inputSchema.properties.application);
  assert.equal(use.inputSchema.properties.activateApplication.default, false);
  assert.match(bridge.description, /Computer Use contract/i);
  assert.match(bridge.description, /application screenshot itself/i);
  assert.deepEqual(bridge.inputSchema.properties.operation.enum, [
    "list_apps", "get_app_state", "click", "drag", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text",
  ]);
  for (const property of ["elementIndex", "snapshotId", "snapshot_id", "element_index", "mouse_button", "click_count", "from_x", "selection_type", "action", "nativeAction"]) assert.ok(bridge.inputSchema.properties[property]);
  assert.equal(bridge.inputSchema.properties.focusedWindowOnly.default, false);
  assert.deepEqual(bridge.outputSchema.properties.coordinateSpace.enum, ["application_screenshot", "semantic_element", "none"]);
  assert.match(cua.description, /page CSS-pixel coordinates/i);
  assert.match(cua.description, /separate from desktop/i);
  assert.deepEqual(cua.inputSchema.properties.actions.items.properties.action.enum, [
    "screenshot", "click", "double_click", "move", "drag", "type", "key", "keypress", "scroll", "download_media", "wait",
  ]);
  assert.equal(cua.inputSchema.properties.actions.maxItems, 20);
  assert.ok(cua.inputSchema.properties.targetClaim);
  for (const property of ["path", "clip", "scrollX", "keypress"]) assert.ok(cua.inputSchema.properties.actions.items.properties[property]);
  assert.ok(cua.outputSchema.properties.screenshotIncluded);
});

test("Computer Use bridge keeps macOS menu headings without closed-menu history", () => {
  const elements = [
    { id: "window", role: "AXWindow" },
    { id: "bar", role: "AXMenuBar" },
    { id: "apple", role: "AXMenuBarItem", name: "Apple" },
    { id: "app", role: "AXMenuBarItem", name: "Fabushi" },
    { id: "app-menu", role: "AXMenu" },
    { id: "about", role: "AXMenuItem", name: "About" },
    { id: "file", role: "AXMenuBarItem", name: "File" },
  ];
  assert.deepEqual(
    pruneComputerUseBridgeElements(elements, { source: "macos-ax", focusedWindowOnly: false }).map(({ id }) => id),
    ["window", "bar", "app", "file"],
  );
  assert.equal(pruneComputerUseBridgeElements(elements, { source: "macos-ax", focusedWindowOnly: true }), elements);
  assert.equal(pruneComputerUseBridgeElements(elements, { source: "windows-uia" }), elements);
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
