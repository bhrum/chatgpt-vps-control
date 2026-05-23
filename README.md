# ChatGPT VPS Control

Small MCP server for connecting ChatGPT to a single Ubuntu VPS.

## Tools

- `vps_status`: read-only system status.
- `run_shell_command`: runs a shell command as the service user with a timeout, output cap, and high-risk command guard.
- `recent_commands`: returns recent command audit entries.

## Run

```bash
npm install
VPS_APP_TOKEN="$(openssl rand -hex 32)" npm start
```

Expose the service to ChatGPT with an HTTPS tunnel or OpenAI Secure MCP Tunnel. The connector URL should include the random token:

```text
https://example-tunnel/mcp/<VPS_APP_TOKEN>
```

Keep this connector private. The token grants command execution as the service user.
