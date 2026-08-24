import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry, TOOLS } from "../cloudflare-worker/src/index.js";

function memoryContext() {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, value); },
    delete: async (key) => values.delete(key),
    list: async ({ prefix } = {}) => new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix))),
  };
  storage.transaction = async (callback) => callback(storage);
  return {
    storage,
    getWebSockets: () => [],
  };
}

test("central MCP advertises one-time device enrollment", () => {
  const tool = TOOLS.find(({ name }) => name === "create_device_enrollment");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.match(tool.description, /single-use, 10-minute enrollment code/i);
  assert.ok(tool.outputSchema.properties.command);
});

test("device enrollment exchanges one code for one per-device credential", async () => {
  const registry = new DeviceRegistry(memoryContext());
  const enrollment = await registry.createEnrollment({ deviceId: "windows-laptop", deviceName: "Windows Laptop" });
  const redeemed = await registry.redeemEnrollment({ code: enrollment.code, deviceId: "windows-laptop", deviceName: "Windows Laptop" });
  assert.equal(redeemed.deviceId, "windows-laptop");
  assert.ok(redeemed.deviceToken.length >= 32);
  assert.deepEqual(await registry.authorizeAgent({ deviceId: redeemed.deviceId, token: redeemed.deviceToken }), { authorized: true });
  await assert.rejects(
    registry.redeemEnrollment({ code: enrollment.code, deviceId: "windows-laptop", deviceName: "Windows Laptop" }),
    /invalid or expired/i,
  );
  assert.deepEqual(await registry.authorizeAgent({ deviceId: redeemed.deviceId, token: "x".repeat(32) }), { authorized: false });
});

test("local enrollment stores the per-device credential without returning it", async () => {
  const home = await mkdtemp(join(tmpdir(), "chatgpt-device-enrollment-test-"));
  const previousHome = process.env.CHATGPT_COMPUTER_HOME;
  process.env.CHATGPT_COMPUTER_HOME = home;
  try {
    const localInstall = await import(`../lib/local-install.js?enrollment=${Date.now()}`);
    await localInstall.setupLocalComputer({ installDependencies: false, port: 18994 });
    const { enrollDevice } = await import(`../lib/device-enrollment.js?enrollment=${Date.now()}`);
    const result = await enrollDevice({
      server: "https://control.example.com/path",
      code: "one-time-code",
      deviceId: "test-windows",
      deviceName: "Test Windows",
      ipFamily: "4",
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://control.example.com/agent/enroll");
        assert.equal(JSON.parse(options.body).deviceId, "test-windows");
        return new Response(JSON.stringify({
          deviceId: "test-windows",
          deviceName: "Test Windows",
          deviceToken: "p".repeat(43),
          gatewayUrl: "wss://control.example.com/agent",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(result.deviceToken, undefined);
    const config = await readFile(join(home, ".env"), "utf8");
    assert.match(config, /^DEVICE_GATEWAY_URL=wss:\/\/control\.example\.com\/agent$/m);
    assert.match(config, /^DEVICE_GATEWAY_TOKEN=p{43}$/m);
    assert.match(config, /^DEVICE_ID=test-windows$/m);
    assert.match(config, /^DEVICE_NAME=Test Windows$/m);
    assert.match(config, /^DEVICE_GATEWAY_IP_FAMILY=4$/m);
  } finally {
    if (previousHome === undefined) delete process.env.CHATGPT_COMPUTER_HOME;
    else process.env.CHATGPT_COMPUTER_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
