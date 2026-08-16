# ChatGPT Computer Control

Installable MCP server that turns a Linux, macOS, or Windows machine into an authenticated computer-control endpoint for ChatGPT-compatible MCP clients.

The project started as `chatgpt-vps-control`. It now keeps the original VPS/file/shell capabilities while adding Grok Bot-style computer use and local installation/runtime setup.

## What installation configures

`chatgpt-computer-control setup` creates a private runtime directory at `~/.chatgpt-computer-control` (Windows: `%USERPROFILE%\.chatgpt-computer-control` unless overridden), generates a strong reusable connector token, configures OAuth state storage, selects the platform computer backend, and prepares the machine for background operation.

| Platform | Computer backend | Setup behavior |
| --- | --- | --- |
| Linux with X11 | `xdotool` + `xrandr/xdpyinfo` + `ffmpeg x11grab` | Uses the signed-in X11 desktop. |
| Headless Linux/VPS | managed X11 (`Xvfb` + `xfwm4`) | If no X11 desktop is reachable, setup configures a persistent 1280×800 virtual desktop that the MCP service starts automatically. |
| macOS | native Swift helper using CoreGraphics/AppKit/Accessibility | Compiles a local helper and asks for Accessibility + Screen Recording permission during `doctor`. |
| Windows | native PowerShell/C# helper using User32 `SendInput` + GDI capture | Uses the signed-in interactive Windows desktop; no third-party input driver is required. |

All backends expose the same normalized 1280-wide API coordinate system so the MCP client does not need platform-specific click coordinates.

## Computer tools

- `computer_environment` — reports the selected platform backend, display readiness, resolution, and native permission state.
- `computer_state` — returns display/API resolution, cursor position, active/visible windows, and optionally an inline screenshot.
- `computer_use` — executes `screenshot`, `click`, `move`, `drag`, `type`, `key`, `scroll`, and `wait`, with up to 9 known follow-up actions in one call and one final screenshot.

`computer_use` keeps the useful behavior recovered from Grok Bot 0.16.0: normalized coordinates, UI settle time before screenshots, batched known actions, and robust Unicode handling on X11. macOS and Windows use native OS input APIs instead of trying to run X11 tools there.

## Other MCP tools

- `vps_status` — legacy-compatible name for a cross-platform computer/system status summary.
- `run_shell_command` — Bash on Linux/macOS, PowerShell on Windows.
- `write_text_file` — create/append UTF-8 text files.
- `write_file` — create/overwrite/append arbitrary files from base64.
- `file_info` — local file metadata and optional SHA-256 calculated in Node (no platform-specific `sha256sum` dependency).
- `read_file` — chunked base64 reads and inline image content.
- `create_download_link` — temporary signed file download URL.
- `recent_commands` — command/computer-action audit history.

The OAuth scope names remain `vps.read` and `vps.write` for backward compatibility with existing connectors, even though the server is now cross-platform.

## Install from this repository

Requires Node.js 20+ and Git.

### Linux / macOS

```bash
git clone https://github.com/bhrum/chatgpt-vps-control.git
cd chatgpt-vps-control
bash scripts/install.sh
```

The installer installs npm dependencies, links the `chatgpt-computer-control` CLI, runs setup/doctor, and installs the user background service.

On apt-based Linux, `setup` can automatically install:

```text
xdotool ffmpeg x11-utils x11-xserver-utils xvfb x11vnc xfwm4
```

On macOS, the native helper requires Xcode Command Line Tools. If they are missing, run:

```bash
xcode-select --install
```

Then rerun setup. `doctor` triggers the normal macOS Accessibility and Screen Recording permission prompts; those permissions still require the signed-in user to approve them in System Settings.

### Windows

Open PowerShell:

```powershell
git clone https://github.com/bhrum/chatgpt-vps-control.git
cd chatgpt-vps-control
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

The installer can use `winget` for Git/Node when they are missing, copies the Windows native helper, configures the MCP, and registers a per-user task that starts at sign-in.

## Manual CLI flow

```bash
npm ci --omit=dev
node bin/chatgpt-computer-control.js setup
node bin/chatgpt-computer-control.js doctor
node bin/chatgpt-computer-control.js service install
node bin/chatgpt-computer-control.js url
```

Useful commands:

```text
chatgpt-computer-control setup [--no-deps] [--host 127.0.0.1] [--port 8787]
chatgpt-computer-control doctor
chatgpt-computer-control serve
chatgpt-computer-control service install
chatgpt-computer-control service remove
chatgpt-computer-control url
```

Configuration is stored with restrictive permissions where the OS supports POSIX modes. Running setup again preserves an existing strong connector token rather than silently rotating it.

## Linux desktop modes

If setup sees a reachable `$DISPLAY`, it records that display and controls the real X11 session.

If no X11 session is reachable, setup writes:

```text
DISPLAY=:99
COMPUTER_MANAGED_X11=1
COMPUTER_X11_SCREEN=1280x800x24
```

When the service starts it launches and owns:

```text
Xvfb :99 -screen 0 1280x800x24 ...
xfwm4 --compositor=off
```

The X server is stopped with the MCP process. Optional VNC observation is disabled by default. If explicitly enabled with `COMPUTER_ENABLE_VNC=1`, `x11vnc` binds to localhost only.

This managed mode is for headless servers. A managed Xvfb desktop is a separate desktop; it does not magically control a physical Wayland/GNOME session. For a physical Linux desktop, use an X11 session or a future Wayland-native driver.

## macOS permissions and behavior

The Swift helper uses:

- CoreGraphics events for mouse, keyboard, drag, and scrolling.
- Unicode keyboard events for text input.
- AppKit/CoreGraphics for frontmost-window information and screenshots.
- Accessibility trust as the authorization boundary for synthetic input.
- Screen Recording permission for screen capture/window metadata.

The helper is built into `~/.chatgpt-computer-control/bin/chatgpt-computer-helper` by setup. `doctor` reports whether both required permissions are granted.

## Windows behavior

The Windows helper uses native User32/GDI APIs:

- `SendInput` for keyboard, Unicode text, buttons, and wheel events.
- `SetCursorPos` for pointer movement/drag paths.
- foreground/visible-window APIs for window state.
- GDI `CopyFromScreen` for screenshots.

Normal control requires an unlocked interactive user session. Windows intentionally isolates the lock screen and UAC secure desktop; this project does not attempt to bypass those OS security boundaries. A non-elevated process also cannot reliably inject input into a higher-integrity application.

## Connecting the MCP

By default the server binds to `127.0.0.1`. The generated local connector URL looks like:

```text
http://127.0.0.1:8787/mcp/<random-private-token>
```

Keep the token private. It grants powerful local capabilities, including shell execution and computer input.

If the MCP client is not on the same machine, do **not** simply open port 8787 to the Internet. Put the loopback service behind an authenticated HTTPS tunnel, private network, VPN, or another transport you trust. The repository's existing OAuth flow can be used by ChatGPT-compatible clients; write/computer actions require `vps.write`, and read/screenshot/file inspection requires `vps.read` or the private static token.

## Security properties

- Default bind address is loopback.
- Static connector token must be at least 24 characters; setup generates 32 random bytes (hex encoded).
- OAuth read/write scopes remain separated.
- Typed computer text is not copied into command history; the audit log records summaries such as `type(18 chars)`.
- Computer screenshots are returned inline and are not automatically persisted by the control module.
- macOS Accessibility/Screen Recording and Windows session/UAC boundaries are respected rather than bypassed.
- VNC, when explicitly enabled for a managed Linux desktop, is localhost-only by default.

This MCP is intentionally high privilege. Install it only on machines you own/administer and expose it only to trusted authenticated clients.

## Development and verification

```bash
npm run check
npm test
```

The cross-platform GitHub Actions workflow validates Node code on Linux/macOS/Windows, compiles and probes the macOS Swift helper, probes the Windows native helper, and runs an end-to-end managed-X11 MCP smoke test on Linux.

The Linux integration test proves the full chain:

```text
setup with no DISPLAY
→ managed Xvfb/xfwm4 starts
→ MCP tools/list
→ computer_environment
→ computer_state + inline PNG
→ computer_use cursor movement + inline PNG
```

## Key configuration

See `.env.example`. Important computer variables:

```text
COMPUTER_SCREENSHOT_SETTLE_MS=1200
COMPUTER_MANAGED_X11=1          # headless Linux only
COMPUTER_X11_SCREEN=1280x800x24
COMPUTER_ENABLE_VNC=0           # optional local-only observer
COMPUTER_VNC_PORT=5909
CHATGPT_COMPUTER_NATIVE_HELPER= # macOS/Windows setup writes this
```
