import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { closeNativeRequestService, nativeServiceRequest } from "../lib/native-request-service.js";

const fixture = fileURLToPath(new URL("../scripts/fixtures/native-request-service-fixture.mjs", import.meta.url));
const spec = { command: process.execPath, args: [fixture], env: process.env };

test("native request service reuses one bounded JSON-lines broker", async () => {
  try {
    const first = await nativeServiceRequest(spec, { sequence: 1 });
    const second = await nativeServiceRequest(spec, { sequence: 2 });
    assert.deepEqual(first.echo, { sequence: 1 });
    assert.deepEqual(second.echo, { sequence: 2 });
  } finally { closeNativeRequestService(); }
});

test("native request service restarts after broker failure", async () => {
  try {
    await assert.rejects(nativeServiceRequest(spec, { crash: true }), /exited|closed/i);
    const recovered = await nativeServiceRequest(spec, { recovered: true });
    assert.deepEqual(recovered.echo, { recovered: true });
  } finally { closeNativeRequestService(); }
});
