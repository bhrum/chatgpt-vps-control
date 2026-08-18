import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve("bin/chatgpt-computer-control.js");

test("macOS helper has a stable named app-bundle identity", async () => {
  const plist = await readFile(resolve("native/macos/Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>ChatGPT Computer Control<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.bhrum\.computer-control<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>ChatGPTComputerControl<\/string>/);
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
