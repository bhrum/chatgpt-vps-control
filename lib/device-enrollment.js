import { hostname } from "node:os";
import { configureDeviceGateway } from "./local-install.js";

function normalizedServer(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new Error("Enrollment server must use https://.");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export async function enrollDevice({ server, code, deviceId, deviceName, ipFamily = "", fetchImpl = fetch }) {
  const origin = normalizedServer(server);
  const id = String(deviceId || hostname().replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 128));
  const name = String(deviceName || hostname()).trim();
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(id)) throw new Error("Device ID must contain only letters, numbers, dot, underscore, or dash.");
  if (!/^[\p{L}\p{N} ._()-]{1,200}$/u.test(name)) throw new Error("Device name may contain letters, numbers, spaces, dot, underscore, parentheses, or dash.");
  const response = await fetchImpl(`${origin}/agent/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: String(code || ""), deviceId: id, deviceName: name }),
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.error || result.message || `Enrollment failed with HTTP ${response.status}.`);
  if (result.deviceId !== id || !result.deviceToken || !result.gatewayUrl) throw new Error("Enrollment server returned an invalid device credential.");
  await configureDeviceGateway({
    gatewayUrl: result.gatewayUrl,
    gatewayToken: result.deviceToken,
    deviceId: id,
    deviceName: name,
    ipFamily,
  });
  return { deviceId: id, deviceName: name, gatewayUrl: result.gatewayUrl };
}
