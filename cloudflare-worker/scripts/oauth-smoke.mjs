import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2] || "http://127.0.0.1:8788";
const setupToken = process.env.OAUTH_SMOKE_SETUP_TOKEN;
const password = process.env.OAUTH_SMOKE_PASSWORD;
if (!setupToken || !password) throw new Error("OAUTH_SMOKE_SETUP_TOKEN and OAUTH_SMOKE_PASSWORD are required.");

async function expectJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

await expectJson(await fetch(`${base}/setup`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-setup-token": setupToken },
  body: JSON.stringify({ password }),
}));

const client = await expectJson(await fetch(`${base}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "OAuth smoke test", redirect_uris: ["https://example.com/callback"] }),
}));

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorizeBody = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: "https://example.com/callback",
  scope: "device.control",
  state: "smoke-state",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: `${base}/mcp`,
  password,
});
const authorize = await fetch(`${base}/oauth/authorize`, { method: "POST", body: authorizeBody, redirect: "manual" });
if (authorize.status !== 302) throw new Error(`Authorization failed: ${authorize.status} ${await authorize.text()}`);
const code = new URL(authorize.headers.get("location")).searchParams.get("code");

const tokens = await expectJson(await fetch(`${base}/oauth/token`, {
  method: "POST",
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: "https://example.com/callback",
    code_verifier: verifier,
    resource: `${base}/mcp`,
  }),
}));

const tools = await expectJson(await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
}));

const resources = await expectJson(await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://widget/sensitive-input-v1.html" } }),
}));

const rotated = await expectJson(await fetch(`${base}/oauth/token`, {
  method: "POST",
  body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }),
}));

console.log(JSON.stringify({
  authorizationRedirect: new URL(authorize.headers.get("location")).origin,
  tools: tools.result.tools.map((tool) => tool.name),
  sensitiveInputUi: resources.result.contents[0]?.mimeType === "text/html;profile=mcp-app" && resources.result.contents[0]?.text.includes("加密并发送"),
  accessTokenIssued: Boolean(tokens.access_token),
  refreshTokenRotated: Boolean(rotated.refresh_token && rotated.refresh_token !== tokens.refresh_token),
}, null, 2));
