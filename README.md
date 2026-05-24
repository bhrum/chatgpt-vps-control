# ChatGPT VPS Control

Small MCP server for connecting ChatGPT to a single Ubuntu VPS.

## Tools

- `vps_status`: read-only system status.
- `run_shell_command`: runs any shell command as the service user. Use `sudo` for root-level operations.
- `write_text_file`: creates a new UTF-8 file or appends text to an existing file without overwriting existing data.
- `recent_commands`: returns recent command audit entries.

Each tool advertises explicit Apps SDK metadata: read/write annotations plus a `noauth` `securitySchemes` mirror in `_meta`. ChatGPT uses these hints to classify read and write operations and frame confirmation prompts; the server still enforces the private connector token on every MCP request.

## Run

```bash
npm install
VPS_APP_TOKEN="$(openssl rand -hex 32)" npm start
```

Expose the service to ChatGPT with an HTTPS tunnel or OpenAI Secure MCP Tunnel. The connector URL should include the random token:

```text
https://example-tunnel/mcp/<VPS_APP_TOKEN>
```

Keep this connector private. The token grants unrestricted command execution through `run_shell_command` as the service user, including root-level operations when commands use `sudo`. The separate `write_text_file` tool is intentionally non-destructive so agent builders can enable a write operation without mislabeling arbitrary shell access.
