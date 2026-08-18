import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64url(value) {
  return new Uint8Array(Buffer.from(String(value), "base64url"));
}

export function resolveSensitiveTemplate(value, fields) {
  if (Array.isArray(value)) return value.map((item) => resolveSensitiveTemplate(item, fields));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSensitiveTemplate(item, fields)]));
  }
  if (typeof value !== "string") return value;
  const match = /^\{\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}\}$/u.exec(value);
  if (!match) return value;
  if (!Object.hasOwn(fields, match[1])) throw new Error(`Sensitive field ${match[1]} was not supplied.`);
  return fields[match[1]];
}

export async function createSecureInputChannel() {
  const keys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await subtle.exportKey("jwk", keys.publicKey);

  return {
    publicKey,
    async decrypt(envelope, challengeId) {
      if (!envelope || typeof envelope !== "object") throw new Error("Missing encrypted sensitive-input envelope.");
      const remotePublicKey = await subtle.importKey(
        "jwk",
        envelope.ephemeralPublicKey,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      const sharedBits = await subtle.deriveBits({ name: "ECDH", public: remotePublicKey }, keys.privateKey, 256);
      const aesKey = await subtle.importKey("raw", sharedBits, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      const plaintext = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64url(envelope.iv),
          additionalData: encoder.encode(challengeId),
        },
        aesKey,
        fromBase64url(envelope.ciphertext),
      );
      const payload = JSON.parse(decoder.decode(plaintext));
      if (payload.challengeId !== challengeId) throw new Error("Sensitive-input challenge binding failed.");
      if (!payload.values || Array.isArray(payload.values) || typeof payload.values !== "object") throw new Error("Sensitive-input values are invalid.");
      return payload.values;
    },
  };
}
