# Cloudflare edge MCP

This Worker is the stable public MCP and device registry. A single SQLite-backed
Durable Object holds hibernatable outbound WebSockets from every computer.

Required Wrangler secrets:

- `MCP_PATH_TOKEN`: random private path segment used by the ChatGPT MCP URL.
- `DEVICE_GATEWAY_TOKEN`: separate bearer token used only by device agents.

Deploy from this directory:

```bash
npx wrangler secret put MCP_PATH_TOKEN
npx wrangler secret put DEVICE_GATEWAY_TOKEN
npx wrangler deploy
```

The resulting endpoints are:

```text
https://chatgpt-device-control.<account>.workers.dev/mcp/<MCP_PATH_TOKEN>
wss://chatgpt-device-control.<account>.workers.dev/agent
```

Do not use the MCP path token as the agent token, and do not commit either.
