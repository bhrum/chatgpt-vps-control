# Cloudflare edge MCP

This Worker is the stable public MCP and device registry. A single SQLite-backed
Durable Object holds hibernatable outbound WebSockets from every computer.

Required Wrangler secrets:

- `OAUTH_SETUP_TOKEN`: one-time bootstrap token for the password setup page.
- `OAUTH_PASSWORD_PEPPER`: random server-side secret used to protect the stored password verifier.
- `DEVICE_GATEWAY_TOKEN`: separate bearer token used only by device agents.
- `MCP_PATH_TOKEN`: legacy private path segment kept temporarily during OAuth migration.

Deploy from this directory:

```bash
npx wrangler secret put OAUTH_SETUP_TOKEN
npx wrangler secret put OAUTH_PASSWORD_PEPPER
npx wrangler secret put DEVICE_GATEWAY_TOKEN
npx wrangler deploy
```

The resulting endpoints are:

```text
https://chatgpt-mcp.371080.xyz/mcp
wss://chatgpt-device-control.<account>.workers.dev/agent
```

Open `https://chatgpt-mcp.371080.xyz/setup#token=<OAUTH_SETUP_TOKEN>` once to
choose the control password. The fragment is not sent in HTTP requests; browser
JavaScript sends it only in the setup request header. The password is stored as
a salted HMAC-SHA256 verifier protected by a separate Worker secret. ChatGPT authorization uses OAuth 2.1 authorization
code + PKCE, one-hour access tokens, and rotating 180-day refresh tokens.

Use `https://chatgpt-mcp.371080.xyz/manage` to revoke all active access and
refresh tokens. Do not commit any secret.

## Dynamic device tool discovery

Each device agent reads its local MCP `tools/list` result and registers a bounded,
sanitized copy of each advertised tool descriptor. The Worker stores those
descriptors separately from the WebSocket attachment and exposes three stable
gateway operations: `list_devices`, `describe_device_tool`, and `device_call`.
`list_devices` includes a compact schema count/version, while
`describe_device_tool` returns one tool's current input/output JSON Schema and
annotations on demand. This lets ChatGPT learn newly deployed device capabilities
without expanding every device tool into the public Worker tool list.

## One-time device enrollment

Call the authenticated MCP tool `create_device_enrollment` to generate a
single-use setup command. The code expires after 10 minutes. The new device
posts the code, its ID, and its display name to `/agent/enroll`, receives an
independent device credential over HTTPS, and then connects to `/agent` with
that credential and `X-Device-Id`. The Durable Object stores only SHA-256
digests of device credentials. The legacy shared `DEVICE_GATEWAY_TOKEN` remains
accepted so already-installed devices can be migrated without downtime.

## Private user input

The MCP exposes an MCP Apps card for passwords, OTPs, API keys, personal data,
account selections, consent, and other sensitive values:

1. The model calls `render_sensitive_input` with non-sensitive field labels and
   device steps containing exact `{{fieldId}}` placeholders.
2. The user enters or selects values inside the ChatGPT card.
3. The card encrypts the complete value map with an ephemeral P-256 ECDH key and
   AES-256-GCM, bound to the one-time challenge ID.
4. Only the selected device agent has the private key. It decrypts, substitutes
   exact placeholders, runs the pre-registered steps, and returns status only.
5. The card clears its controls and sends a value-free follow-up message so the
   model continues from the new device state.

Challenges expire after five minutes and are deleted before execution. Plaintext
values are never returned in MCP content, structured content, logs, Durable
Object storage, or conversation state.
