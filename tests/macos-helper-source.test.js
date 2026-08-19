import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("macOS helper enables lazy web accessibility trees before traversal", async () => {
  const source = await readFile(resolve("native/macos/ComputerHelper.swift"), "utf8");
  assert.match(source, /func axEnableApplicationTree/);
  assert.match(source, /AXManualAccessibility/);
  assert.match(source, /AXEnhancedUserInterface/);
  assert.match(source, /AXChildrenInNavigationOrder/);
  assert.match(source, /"AXVisibleChildren"/);
  assert.match(source, /"AXContents"/);
  assert.match(source, /let axContainerRoles/);
  assert.match(source, /"AXMenuBar"/);
  assert.match(source, /includeContainers && \(hasIdentity \|\| axContainerRoles\.contains\(role\)\)/);
  assert.match(source, /axEnableApplicationTree\(root\)/);
  assert.match(source, /if role == "AXMenuBarItem" \{ return \}/);
  assert.match(source, /role == "AXMenuBar" && index == 0/);
});

test("raw coordinate actions use AX event settling before screenshot capture", async () => {
  const source = await readFile(resolve("native/macos/ComputerHelper.swift"), "utf8");
  assert.match(source, /let rawSettleObservation = rawTargetPid\.flatMap\(beginAXSettleObservation\)/);
  assert.match(source, /finishAXSettleObservation\(rawSettleObservation, minimum: 0\.8, quietWindow: 0\.45, maximum: 5\.0\)/);
});

test("macOS semantic pointer actions stay scoped to the snapshot process", async () => {
  const source = await readFile(resolve("native/macos/ComputerHelper.swift"), "utf8");
  assert.match(source, /postClick\(point, button: mouseButton\(request\.button\), count: [^\n]+, targetPid: decoded\.pid\)/);
  assert.match(source, /scrollWheelEvent2Source:[^\n]+targetPid: decoded\.pid\)/);
  assert.match(source, /"control_l", "control_r"/);
});

test("Windows accepts Computer Use keysym-style modifier aliases", async () => {
  const source = await readFile(resolve("native/windows/computer-helper.ps1"), "utf8");
  assert.match(source, /'control_l'=0x11/);
  assert.match(source, /'super_l'=0x5B/);
});
