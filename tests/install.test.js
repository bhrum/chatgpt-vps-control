import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve("bin/chatgpt-computer-control.js");

test("macOS helper has a stable named app-bundle identity", async () => {
  const [plist, servicePlist] = await Promise.all([
    readFile(resolve("native/macos/Info.plist"), "utf8"),
    readFile(resolve("native/macos/RequestService-Info.plist"), "utf8"),
  ]);
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>ChatGPT Computer Control<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.bhrum\.computer-control<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>ChatGPTComputerControl<\/string>/);
  assert.match(servicePlist, /com\.bhrum\.computer-control\.request-service/);
  assert.match(servicePlist, /<key>CFBundlePackageType<\/key>\s*<string>XPC!<\/string>/);
  assert.match(servicePlist, /<key>ServiceType<\/key>\s*<string>Application<\/string>/);
});

test("native input helpers fail closed on locked or non-interactive desktops", async () => {
  const [mac, windows, linux] = await Promise.all([
    readFile(resolve("native/macos/ComputerHelper.swift"), "utf8"),
    readFile(resolve("native/windows/computer-helper.ps1"), "utf8"),
    readFile(resolve("native/linux/accessibility-helper.py"), "utf8"),
  ]);
  assert.match(mac, /CGSessionCopyCurrentDictionary/);
  assert.match(mac, /CGSSessionScreenIsLocked/);
  assert.match(mac, /AXObserverCreate/);
  assert.match(windows, /OpenInputDesktop/);
  assert.match(windows, /SwitchDesktop/);
  assert.match(windows, /AddStructureChangedEventHandler/);
  assert.match(linux, /LockedHint/);
  assert.match(linux, /interactiveDesktop/);
  assert.match(linux, /registerEventListener/);
});

test("setup creates a private reusable local configuration without installing dependencies", async () => {
  const home = await mkdtemp(join(tmpdir(), "chatgpt-computer-control-test-"));
  try {
    const result = spawnSync(process.execPath, [cli, "setup", "--no-deps", "--port", "18991"], {
      env: { ...process.env, CHATGPT_COMPUTER_HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const env = await readFile(join(home, ".env"), "utf8");
    assert.match(env, /^HOST=127\.0\.0\.1$/m);
    assert.match(env, /^PORT=18991$/m);
    const token = env.match(/^VPS_APP_TOKEN=(.+)$/m)?.[1] ?? "";
    assert.ok(token.length >= 48);
    const mode = (await stat(join(home, ".env"))).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);
    if (process.platform === "darwin") {
      const serviceRoot = join(home, "Applications", "ChatGPT Computer Control.app", "Contents", "XPCServices", "com.bhrum.computer-control.request-service.xpc", "Contents");
      assert.ok((await stat(join(serviceRoot, "MacOS", "ChatGPTComputerRequestService"))).isFile());
      const servicePlist = await readFile(join(serviceRoot, "Info.plist"), "utf8");
      assert.match(servicePlist, /com\.bhrum\.computer-control\.request-service/);
    }

    const second = spawnSync(process.execPath, [cli, "setup", "--no-deps", "--port", "18991"], {
      env: { ...process.env, CHATGPT_COMPUTER_HOME: home },
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const envAgain = await readFile(join(home, ".env"), "utf8");
    assert.equal(envAgain.match(/^VPS_APP_TOKEN=(.+)$/m)?.[1], token, "setup must preserve an existing strong token");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

if (process.platform === "linux") {
  test("setup selects managed X11 when no desktop display is available", async () => {
    const home = await mkdtemp(join(tmpdir(), "chatgpt-computer-control-headless-test-"));
    try {
      const env = { ...process.env, CHATGPT_COMPUTER_HOME: home };
      delete env.DISPLAY;
      const result = spawnSync(process.execPath, [cli, "setup", "--no-deps", "--port", "18992"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const config = await readFile(join(home, ".env"), "utf8");
      assert.match(config, /^DISPLAY=:99$/m);
      assert.match(config, /^COMPUTER_MANAGED_X11=1$/m);
      assert.match(config, /^COMPUTER_X11_SCREEN=1280x800x24$/m);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
