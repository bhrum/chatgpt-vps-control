# ChatGPT VPS Control

Small MCP server for connecting ChatGPT to a single Ubuntu VPS.

## Tools

- `vps_status`: read-only system status.
- `run_shell_command`: runs any shell command as the service user. Use `sudo` for root-level operations.
- `write_text_file`: creates a new UTF-8 file or appends text to an existing file without overwriting existing data.
- `recent_commands`: returns recent command audit entries.

Each tool advertises explicit Apps SDK metadata: read/write annotations plus tool-level `securitySchemes`. Read-only tools allow `noauth`; write tools advertise OAuth scope `vps.write` and mirror the same scheme in `_meta` for ChatGPT compatibility. The server still accepts the private connector token on every MCP request and also includes a minimal OAuth 2.1 flow for ChatGPT account linking tests.

## Auth behavior

The MCP endpoint uses mixed authentication:

- `initialize`, `tools/list`, `vps_status`, and `recent_commands` can run without OAuth so ChatGPT can keep the app connected and refresh tool metadata.
- `run_shell_command` and `write_text_file` require either the private `VPS_APP_TOKEN` in the URL/query/Bearer token or OAuth scope `vps.write`.
- When a write tool is called without a valid token, the tool result returns `_meta["mcp/www_authenticate"]` so ChatGPT can launch the OAuth flow for that tool instead of marking the whole app disconnected.

OAuth access tokens default to a 10-year lifetime. Refresh tokens do not expire in this server. Tokens are persisted by default at `~/.chatgpt-vps-control/oauth-tokens.json`, with a one-time migration from the older `./oauth-tokens.json` path when present. Override the store with `OAUTH_TOKEN_STORE_PATH` if systemd should keep it somewhere else.

ChatGPT may still force a fresh authorization for account, workspace, or product-side security reasons. This server can keep its own OAuth tokens valid and refreshable, but it cannot force ChatGPT to retain a connector grant forever.

## Command and file size behavior

The server no longer advertises a fixed `maxLength` for `run_shell_command.command` or `write_text_file.content`. Shell commands are sent to Bash over stdin instead of as a single `bash -lc` argument, which avoids the operating system's argument-length ceiling for long commands.

There is still no true infinite payload in practice: ChatGPT, the MCP transport/client, Cloudflare or other proxies, Node memory, and server disk space can all impose outer limits. Command output is intentionally clipped by `MAX_OUTPUT_CHARS` so one tool call cannot exhaust memory while streaming logs.

## Run

```bash
npm install
VPS_APP_TOKEN="$(openssl rand -hex 32)" npm start
```

Expose the service to ChatGPT with an HTTPS tunnel or OpenAI Secure MCP Tunnel. The connector URL should include the random token:

```text
https://example-tunnel/mcp/<VPS_APP_TOKEN>
```

For OAuth-only ChatGPT app setup, use the public MCP URL without the private token:

```text
https://example-tunnel/mcp
```

### Permanent Cloudflare Named Tunnel Setup

To make the connection permanent and persistent (not changing), you can set up a Cloudflare Named Tunnel pointing to a custom subdomain (e.g., `vps-mcp.ombhrum.com`):

1. **Create the Named Tunnel on local Mac** (with access to your Cloudflare `cert.pem`):
   ```bash
   cloudflared tunnel create chatgpt-vps-control
   cloudflared tunnel route dns chatgpt-vps-control vps-mcp.ombhrum.com
   ```
2. **Copy the credentials file to the VPS**:
   ```bash
   scp ~/.cloudflared/7017aefa-0c87-4b1b-82a8-a7713af50d2e.json ubuntu@<VPS_IP>:~/.cloudflared/
   ```
3. **Configure `cloudflared` on the VPS** (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: 7017aefa-0c87-4b1b-82a8-a7713af50d2e
   credentials-file: /home/ubuntu/.cloudflared/7017aefa-0c87-4b1b-82a8-a7713af50d2e.json

   ingress:
     - hostname: vps-mcp.ombhrum.com
       service: http://localhost:8787
     - service: http_status:404
   ```
4. **Update systemd service** `/etc/systemd/system/chatgpt-vps-tunnel.service` on the VPS:
   ```ini
   [Unit]
   Description=Cloudflare persistent named tunnel for ChatGPT VPS Control
   After=network-online.target chatgpt-vps-control.service
   Wants=network-online.target
   Requires=chatgpt-vps-control.service

   [Service]
   Type=simple
   User=ubuntu
   ExecStart=/usr/local/bin/cloudflared tunnel --config /home/ubuntu/.cloudflared/config.yml run
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
5. **Reload and Restart**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart chatgpt-vps-tunnel.service
   ```

Keep this connector private. The token grants unrestricted command execution through `run_shell_command` as the service user, including root-level operations when commands use `sudo`. The separate `write_text_file` tool is intentionally non-destructive so agent builders can enable a write operation without mislabeling arbitrary shell access.
