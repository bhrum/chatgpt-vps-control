import { webcrypto } from "node:crypto";

const mcpUrl = process.env.SENSITIVE_INPUT_MCP_URL;
const deviceId = process.env.SENSITIVE_INPUT_DEVICE_ID;
if (!mcpUrl || !deviceId) throw new Error("SENSITIVE_INPUT_MCP_URL and SENSITIVE_INPUT_DEVICE_ID are required.");
const encoder = new TextEncoder();

async function rpc(id, method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.SENSITIVE_INPUT_BEARER ? { authorization: `Bearer ${process.env.SENSITIVE_INPUT_BEARER}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload.result;
}

const challengeResult = await rpc(1, "tools/call", {
  name: "render_sensitive_input",
  arguments: {
    deviceId,
    title: "Encrypted input smoke test",
    description: "Verify the encrypted user-to-device path without entering a real secret.",
    fields: [{ id: "probe", label: "Test selection", type: "select", options: [{ value: "secure-probe", label: "Encrypted test value" }] }],
    steps: [{ toolName: "computer_environment", arguments: { display: "{{probe}}" } }],
  },
});
const challenge = challengeResult.structuredContent;
const devicePublic = await webcrypto.subtle.importKey("jwk", challenge.devicePublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
const ephemeral = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const shared = await webcrypto.subtle.deriveBits({ name: "ECDH", public: devicePublic }, ephemeral.privateKey, 256);
const aes = await webcrypto.subtle.importKey("raw", shared, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const encrypted = await webcrypto.subtle.encrypt(
  { name: "AES-GCM", iv, additionalData: encoder.encode(challenge.challengeId) },
  aes,
  encoder.encode(JSON.stringify({ challengeId: challenge.challengeId, values: { probe: "secure-probe" } })),
);
const submitted = await rpc(2, "tools/call", {
  name: "submit_sensitive_input",
  arguments: {
    challengeId: challenge.challengeId,
    ephemeralPublicKey: await webcrypto.subtle.exportKey("jwk", ephemeral.publicKey),
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(encrypted).toString("base64url"),
  },
});
console.log(JSON.stringify(submitted.structuredContent, null, 2));
