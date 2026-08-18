import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { createSecureInputChannel, resolveSensitiveTemplate } from "../lib/secure-input.js";

const encoder = new TextEncoder();

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

test("sensitive input is encrypted to one device and bound to one challenge", async () => {
  const channel = await createSecureInputChannel();
  const ephemeral = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const devicePublic = await webcrypto.subtle.importKey("jwk", channel.publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await webcrypto.subtle.deriveBits({ name: "ECDH", public: devicePublic }, ephemeral.privateKey, 256);
  const aes = await webcrypto.subtle.importKey("raw", shared, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const challengeId = "12345678-1234-1234-1234-123456789abc";
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(challengeId) },
    aes,
    encoder.encode(JSON.stringify({ challengeId, values: { password: "private-value", choice: "account-b" } })),
  );
  const envelope = {
    ephemeralPublicKey: await webcrypto.subtle.exportKey("jwk", ephemeral.publicKey),
    iv: base64url(iv),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  };
  assert.deepEqual(await channel.decrypt(envelope, challengeId), { password: "private-value", choice: "account-b" });
  await assert.rejects(() => channel.decrypt(envelope, "different-challenge-id"));
});

test("sensitive placeholders are only substituted as complete values", () => {
  const resolved = resolveSensitiveTemplate({ value: "{{password}}", literal: "prefix {{password}}", nested: ["{{choice}}"] }, { password: "p", choice: true });
  assert.deepEqual(resolved, { value: "p", literal: "prefix {{password}}", nested: [true] });
});
