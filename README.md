# ChatGPT Computer Control

Installable MCP server that turns a Linux, macOS, or Windows machine into an authenticated computer-control endpoint for ChatGPT-compatible MCP clients.

The project started as `chatgpt-vps-control`. It now keeps the original VPS/file/shell capabilities while adding Grok Bot-style computer use and local installation/runtime setup.

## What installation configures

`chatgpt-computer-control setup` creates private application data at `~/.chatgpt-computer-control` (Windows: `%USERPROFILE%\.chatgpt-computer-control` unless overridden), generates a strong reusable connector token, configures OAuth state storage, selects the platform computer backend, and prepares the machine for background operation. `service install` then copies the executable Node package and dependencies into a content-addressed runtime beneath that directory before registering the background service. Long-running Node and Chrome native-host processes therefore never execute code from a checkout under Desktop, Documents, or Downloads.

| Platform | Computer backend | Setup behavior |
| --- | --- | --- |
| Linux with X11 | `xdotool` + `wmctrl` + `xrandr/xdpyinfo` + `ffmpeg x11grab` | Uses the signed-in X11 desktop. |
| Headless Linux/VPS | managed X11 (`Xvfb` + `xfwm4`) | If no X11 desktop is reachable, setup configures a persistent 1280×800 virtual desktop that the MCP service starts automatically. |
| macOS | signed app-bundled Swift helper using CoreGraphics/AppKit/Accessibility | Installs `ChatGPT Computer Control.app` with a stable Bundle ID so macOS permission panels show the product name instead of `node`. |
| Windows | native PowerShell/C# helper using User32 `SendInput` + GDI capture | Uses the signed-in interactive Windows desktop; no third-party input driver is required. |

All backends expose the same normalized 1280-wide API coordinate system so the MCP client does not need platform-specific click coordinates.

## Computer tools

- `computer_environment` — reports the selected platform backend, display readiness, resolution, and native permission state.
- `computer_applications` — lists installed/running desktop apps with stable platform identifiers (`com.google.Chrome`, `win32:notepad`, `startapp:…`, `atspi:…`, or `desktop:…`), plus nullable `lastUsedDate` and `useCount` when backed by OS usage evidence. Results prioritize running and recently used apps without inventing history where a platform does not expose it.
- `computer_app_state` — returns a rich app-scoped accessibility tree plus an application-window-scoped screenshot and its desktop-coordinate bounds, then compact element diffs on later calls unless a fresh full tree is requested. If a platform cannot identify a target window, the result explicitly reports `screenshotScope=desktop` instead of silently presenting a full-screen image as app-scoped.
- `computer_browser_session` — starts a dedicated Chrome/Chromium profile, discovers an explicitly configured loopback CDP browser, or enumerates ordinary signed-in Chrome tabs through the optional extension. The MCP selects a fresh listed tab by browser generation, ID, title and URL, then atomically claims only that exact target before control. All modes support exact-target navigation, new/activate/close tab, back/forward/reload, and page-only screenshots. Targets expose `owner` and `retained`; tool-created tabs begin as temporary automation tabs. Page changes invalidate the claim, and attached/extension browsers can never be stopped through this tool.
- `computer_browser_utility` — binds to an exact target for live HTML/text export, private PDF generation, page clipboard read/write, buffered console/exception/developer-log inspection, JavaScript alert/confirm/prompt handling, and browser-level download tracking, waiting, or cancellation. PDFs are validated, capped at 64 MiB, written atomically without overwriting under the session's private `exports` directory, and can be reused by that session's restricted file-upload flow. Downloads remain confined to the private session directory and clipboard writes are never echoed.
- `computer_browser_locator` — runs up to 20 declarative visible-DOM steps against one exact managed target. It can enter a chain of up to eight same-origin or cross-origin frames through isolated CDP worlds, inspect or wait for CSS/role/name/text locators, click/double-click, hover, focus, fill, append text, check/uncheck, select options, safely set file inputs, drag one located element to another, press keys, scroll, and read attributes, then returns a target-only screenshot. Uploads accept only regular files under the workspace, that session's download or export directory, or explicit `COMPUTER_BROWSER_UPLOAD_ROOTS`; arbitrary JavaScript evaluation is not exposed.
- `computer_browser_cua` — sends bounded screenshot/click/double-click/move/drag/type/keypress/scroll/media-download/wait batches to one exact claimed browser tab in page CSS-pixel coordinates, with modifier keys, drag paths, raw scroll deltas, clipped or full-page capture, and a target-only screenshot. Its page coordinate space is deliberately separate from desktop `computer_use` coordinates, and stale or mismatched browser claims fail closed.
- `computer_elements` — returns a short-lived indexed accessibility snapshot from Linux AT-SPI, macOS AXUIElement, Windows UI Automation, or Chrome/Electron CDP.
- `computer_element_action` — performs `press`, multi-button/multi-click `click`, `focus`, `set_value`, contextual `select_text`, `toggle`, `increment`, `decrement`, `scroll_into_view`, or direction/page-based `scroll` against an element index. A process-lifetime native observer caches events for each target application, records a generation before mutation, and waits for the post-action generation to become quiet. If that service is unavailable, the action-scoped macOS AXObserver, Windows UIA, Linux AT-SPI, browser DOM fingerprint, and semantic polling paths remain fail-safe fallbacks. The result includes settle source/duration/event count, the same application's stabilized window screenshot and bounds (or an explicit desktop fallback), replacement snapshot id, and refreshed state.
- `computer_element_secondary_action` — performs an exact native accessibility action advertised by the selected element; guessed action names are rejected.
- `computer_state` — returns display/API resolution, cursor position, active/visible windows, and optionally an inline screenshot.
- `computer_window` — acts on an exact window id and short-lived identity claim from `computer_state`: activate, close, minimize, maximize, restore, or move/resize in normalized screenshot coordinates. The claim is bound to desktop, id, and title so a recycled native handle fails closed. It returns refreshed visible windows and a post-action screenshot without retrying a successful mutation if capture permission is unavailable.
- `computer_use` — executes coordinate-level `screenshot`, `click`, `move`, `drag`, `type`, `key`, `scroll`, and `wait`, with up to 9 known follow-up actions in one call and one final screenshot.
- `computer_use_bridge` — provides one remote MCP entrypoint with the same app-scoped operation vocabulary as Computer Use: `list_apps`, `get_app_state`, `click`, `drag`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, and `type_text`. It remembers a short-lived per-app snapshot, rejects stale element indexes, returns full state first and compact diffs later, and translates coordinates from the actual application screenshot into the platform backend's private normalized space. This is the preferred compatibility mode for a dynamic device reached through `device_call`.

Use semantic control first: call `computer_applications`, select the stable app id, then call `computer_app_state` or `computer_elements` with that id. `computer_app_state` ensures the app is running but does not bring an already-running app to the foreground unless `activate=true`; ordinary signed-in Chrome work should use the extension-backed browser session and stays in the background. Select a named role/control and call `computer_element_action`; a successful write invalidates the old snapshot and normally returns `nextSnapshotId` plus refreshed state for the next decision. For a Computer Use-style act-then-observe loop, pass `returnState=false` to make the write action-only, then explicitly read fresh state. `computer_app_state` uses an app-scoped session: its first response is a full tree and later responses contain only additions, changes, and removals. It reads the focused window by default, so an OS file chooser replaces the underlying browser page instead of forcing a scan through both. On large browser-internal pages such as `chrome://extensions`, pass `query` (for example, the localized Load unpacked label) and a small `maxElements`; native AX/UIA traversal is bounded by `maxDepth` and `maxVisitedNodes`. This desktop path can operate browser chrome and native file choosers that page CDP intentionally cannot access. Snapshots expire after 90 seconds and expose only indexes; native handles and CDP node identifiers remain private inside the MCP process. All semantic providers normalize hierarchy depth, subrole/class, stable element identifier, placeholder, URL, state, bounds, semantic actions, and exact native actions where the platform exposes them. `select_text` supports matching context through `prefix`/`suffix` and `text`, `cursor_before`, or `cursor_after` selection modes. Use `computer_use` as the visual/coordinate fallback when an application does not expose a usable accessibility element; its optional `application` field explicitly activates the selected app before sending global keyboard or mouse input on macOS, Windows, and Linux.

For the compatibility bridge, call `computer_use_bridge { operation: "get_app_state", app: "<stable app id>" }` before any action, then pass its `snapshotId` back as `snapshot_id` with the write. It returns the complete application tree and compact menu-bar headings by default; use `focusedWindowOnly=true` for a native dialog or one focused window. When `screenshotScope` is `application`, the returned image is the coordinate space and no caller-side 1280 scaling is needed; a desktop fallback is explicitly labeled and permits semantic-index actions only. Every action atomically consumes the supplied snapshot and returns refreshed state plus a replacement snapshot, so concurrent or delayed callers fail closed instead of applying an old index to a new tree. The original Computer Use spellings (`element_index`, `mouse_button`, `click_count`, `from_x`, `from_y`, `to_x`, `to_y`, `selection_type`, and secondary `action`) are accepted directly; `snapshot_id` is the bridge's additional remote-generation guard, and the older camel-case connector spellings remain compatible.

Before any input, the native backends verify that the normal interactive user desktop is available. macOS rejects locked or non-console CGSessions, Windows rejects locked/disconnected input desktops and the UAC secure desktop, and physical Linux sessions honor logind `Active`/`LockedHint`. Managed private Xvfb sessions remain controllable through their isolated display. Read-only state inspection remains available so callers can report why control is paused without guessing or retrying an action.

The implementation is independent and platform-native: macOS uses AXUIElement, Windows uses UI Automation patterns, Linux uses AT-SPI plus freedesktop application entries, and Chrome/Electron uses CDP. The private Computer Use service requires its trusted Node REPL host, so this project does not forward that private pipe; the compatibility bridge enforces the same public action contract through this connector's own OAuth/device security boundary. See [docs/clean-room-computer-use.md](docs/clean-room-computer-use.md), [docs/chatgpt-control-parity.md](docs/chatgpt-control-parity.md), and [docs/fabushi-computer-use-comparison.md](docs/fabushi-computer-use-comparison.md).

macOS and Windows native calls normally pass through a restartable process-lifetime broker with bounded JSON-lines requests, isolated per-request action children, and transparent one-shot fallback only for transport failure. On macOS, the signed persistent broker owns the ScreenCaptureKit window catalog and hot screenshot path while actions remain isolated; this avoids a capture-service cold start on every UI action. The app also embeds a separately signed `com.bhrum.computer-control.request-service.xpc` compatibility service with mutual code-signing checks. Set `CHATGPT_COMPUTER_NATIVE_PERSISTENT=0` only for diagnostics when the broker itself must be bypassed.

The coordinate fallback keeps the useful behavior recovered from Grok Bot 0.16.0: normalized coordinates, UI settle time before screenshots, batched known actions, and robust Unicode handling on X11. macOS and Windows use native OS input APIs instead of trying to run X11 tools there.

## Use an already signed-in Chrome browser

Ordinary Chrome does not expose CDP unless it was launched with remote debugging. To control selected tabs in the Chrome instance the user already uses, install the bundled Manifest V3 bridge:

```bash
chatgpt-computer-control browser-extension install
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the exact path printed by the command. The next `computer_browser_session` `list` call returns an `extension-…` session containing current ordinary `http`/`https` tabs. The MCP chooses one from that fresh list and atomically claims it by ID, title and URL before attaching the debugger; users do not need to share tabs one by one.

The extension uses Chrome Native Messaging; it does not require Chrome to be restarted with a debugging flag. The native host is restricted to this installation's generated extension ID and authenticates to a private user-only socket with a random local secret. A persistent profile instance id and browser-start generation prevent claims from surviving the wrong Chrome lifetime. Enumeration does not attach a debugger; attachment happens only after an exact fresh claim. Debugger commands are serialized, Native Messaging reconnects through heartbeat alarms and bounded backoff, child tabs inherit control only from an already controlled opener, and automation tabs are kept in a named group. The extension never exports the Chrome profile, passwords, cookies, or session storage.

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
xdotool wmctrl ffmpeg x11-utils x11-xserver-utils xvfb x11vnc xfwm4
dbus-x11 at-spi2-core python3-pyatspi gir1.2-atspi-2.0 libglib2.0-bin
```

On macOS, the native helper requires Xcode Command Line Tools. If they are missing, run:

```bash
xcode-select --install
```

Then rerun setup. `doctor` triggers the normal macOS Accessibility and Screen Recording permission prompts for **ChatGPT Computer Control**; those permissions still require the signed-in user to approve them in System Settings. Older installations that showed `node` for Accessibility or Screen Recording must rerun `setup` to migrate from the bare helper executable to the named app bundle.

If macOS instead says that **node wants to access files in Documents/Desktop/Downloads**, the registered service or Chrome native host is still executing a repository script from that protected folder. Rerun `chatgpt-computer-control service install` and `chatgpt-computer-control browser-extension install`. Both launchers will be rewritten to the private content-addressed runtime under `~/.chatgpt-computer-control/runtime/…`; moving the checkout or upgrading Homebrew Node will no longer make routine service calls reread that protected checkout.

After migration, macOS may retain the old `node` row as historical TCC state. Enable **ChatGPT Computer Control** and disable/remove the old `node` entry manually if it is no longer used; setup deliberately does not reset all Node permissions because that could affect unrelated development tools.

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
D-Bus session + AT-SPI accessibility bus
Xvfb :99 -screen 0 1280x800x24 ...
xfwm4 --compositor=off
```

Applications launched by the service inherit `NO_AT_BRIDGE=0` and `GTK_MODULES=gail:atk-bridge`, allowing accessible GTK/X11 applications to appear in `computer_elements`. Chrome or Electron applications that expose a loopback DevTools endpoint are additionally available through the CDP provider.

The X server is stopped with the MCP process. Optional VNC observation is disabled by default. If explicitly enabled with `COMPUTER_ENABLE_VNC=1`, `x11vnc` binds to localhost only.

This managed mode is for headless servers. A managed Xvfb desktop is a separate desktop; it does not magically control a physical Wayland/GNOME session. For a physical Linux desktop, use an X11 session or a future Wayland-native driver.

## macOS permissions and behavior

The Swift helper uses:

- CoreGraphics events for mouse, keyboard, drag, and scrolling.
- Unicode keyboard events for text input.
- AppKit/CoreGraphics for frontmost-window information and screenshots.
- Accessibility trust as the authorization boundary for synthetic input.
- AXUIElement traversal and actions for semantic controls.
- Screen Recording permission for screen capture/window metadata.

The helper is installed at `~/Applications/ChatGPT Computer Control.app` with Bundle ID `com.bhrum.computer-control` (isolated test installs keep it beneath their configured home). The executable inside the bundle—not Node—calls the protected macOS APIs. `doctor` reports whether both required permissions are granted. Development installs are ad-hoc signed; set `CHATGPT_COMPUTER_CODESIGN_IDENTITY` to an Apple Development or Developer ID identity for stable production signing across rebuilds.

For repeatable signing, configure the certificate SHA-1 fingerprint rather than its display name. Setup persists that identity, refuses to silently fall back to ad-hoc signing, and verifies that the resulting designated requirement contains the fixed Bundle ID, an Apple signing anchor, and a Team ID. Normal source updates signed by the same team and identity therefore continue to satisfy the authorization recorded by macOS.

Set `CHATGPT_COMPUTER_TEAM_ID` as well to generate an explicit team-based designated requirement. This prevents certificate renewal from turning the same product into a new TCC identity as long as the Apple Team and Bundle ID remain unchanged.

## Windows behavior

The Windows helper uses native User32/GDI APIs:

- `SendInput` for keyboard, Unicode text, buttons, and wheel events.
- `SetCursorPos` for pointer movement/drag paths.
- foreground/visible-window APIs for window state.
- Windows UI Automation patterns for semantic controls.
- GDI `CopyFromScreen` for screenshots.

Normal control requires an unlocked interactive user session. Windows intentionally isolates the lock screen and UAC secure desktop; this project does not attempt to bypass those OS security boundaries. A non-elevated process also cannot reliably inject input into a higher-integrity application.

## Connecting the MCP

By default the server binds to `127.0.0.1`. The generated local connector URL looks like:

```text
http://127.0.0.1:8787/mcp/<random-private-token>
```

Keep the token private. It grants powerful local capabilities, including shell execution and computer input.

### Sensitive input handoff

The Cloudflare MCP can pause a remote computer task and render a private MCP Apps
card in ChatGPT for passwords, OTPs, secrets, personal details, account choices,
and explicit confirmations. Values are encrypted in the card to the selected
device agent with ephemeral P-256 ECDH and AES-256-GCM. The central Worker and
ChatGPT receive ciphertext and completion status only. Device steps use exact
`{{fieldId}}` placeholders, challenges expire after five minutes, and every
challenge is single-use.

If the MCP client is not on the same machine, do **not** simply open port 8787 to the Internet. Put the loopback service behind an authenticated HTTPS tunnel, private network, VPN, or another transport you trust. The repository's existing OAuth flow can be used by ChatGPT-compatible clients; write/computer actions require `vps.write`, and read/screenshot/file inspection requires `vps.read` or the private static token.

## Dynamic multi-device gateway

One public MCP can act as the central registry for computers that connect later. Enable the gateway only on the central server:

```text
DEVICE_GATEWAY_LISTEN=1
DEVICE_GATEWAY_TOKEN=<shared random token of at least 32 characters>
DEVICE_CENTRAL_ID=central-vps
DEVICE_CENTRAL_NAME=Central VPS
```

On each computer that should appear dynamically, configure the outbound agent:

```text
DEVICE_GATEWAY_URL=wss://control.example.com/agent
DEVICE_GATEWAY_TOKEN=<same shared token>
DEVICE_ID=my-computer
DEVICE_NAME=My Computer
```

If a local network advertises unusable IPv6 connectivity to `workers.dev`, set
`DEVICE_GATEWAY_IP_FAMILY=4` on that device. This changes only the outbound
gateway connection and does not expose an inbound port.

The central MCP keeps a stable gateway surface: `list_devices` returns the live registry plus a compact tool-schema count/version, `describe_device_tool` returns the current MCP title/description/input/output schema for one advertised device tool, and `device_call` forwards a named MCP tool plus JSON arguments to a connected device. Device agents upload bounded, sanitized tool descriptors when they register, so ChatGPT can discover newly added local capabilities without hard-coding their arguments or reinstalling the plugin. Adding another computer still does not change the central tool list. Agents make outbound WebSocket connections, so individual computers do not need public inbound ports.

### Fast, per-device enrollment

The public MCP exposes `create_device_enrollment`. It creates a single-use code
that expires after 10 minutes and may optionally be locked to a device ID and
display name. The shared `DEVICE_GATEWAY_TOKEN` is never returned to ChatGPT or
copied to the new computer.

On a computer where `chatgpt-computer-control setup` has already been run, use
the command returned by the MCP:

```bash
chatgpt-computer-control enroll \
  --server https://chatgpt-mcp.371080.xyz \
  --code <one-time-code> \
  --id my-computer \
  --name "My Computer"
chatgpt-computer-control service install
```

The enrollment endpoint exchanges the one-time code directly for a unique
device credential, stores it only in the private local configuration, and does
not print it. Reusing an enrollment code fails. Existing agents using the legacy
shared gateway token remain compatible during migration.

## Security properties

- Default bind address is loopback.
- Static connector token must be at least 24 characters; setup generates 32 random bytes (hex encoded).
- OAuth read/write scopes remain separated.
- Typed computer text is not copied into command history; the audit log records summaries such as `type(18 chars)`.
- Computer screenshots are returned inline and are not automatically persisted by the control module.
- macOS Accessibility/Screen Recording and Windows session/UAC boundaries are respected rather than bypassed.
- VNC, when explicitly enabled for a managed Linux desktop, is localhost-only by default.
- Browser-extension control is disabled until the separate install command is run. Once enabled, it lists ordinary webpage tab metadata to the authenticated local MCP, but attaches `chrome.debugger` only after an exact generation/ID/title/URL claim.

This MCP is intentionally high privilege. Install it only on machines you own/administer and expose it only to trusted authenticated clients.

## Development and verification

```bash
npm run check
npm test
```

The cross-platform GitHub Actions workflow validates Node code and dependency audit status on Linux/macOS/Windows, typechecks and probes the macOS Swift helper, runs a real WinForms/UI Automation interaction on Windows, and runs an end-to-end managed-X11 semantic MCP test on Linux.

The Linux integration test proves the full chain:

```text
setup with no DISPLAY
→ managed D-Bus + AT-SPI + Xvfb/xfwm4 starts
→ MCP tools/list
→ computer_environment
→ computer_state + inline PNG
→ computer_use cursor movement + inline PNG
→ start Chrome on the managed display
→ computer_elements(browser) → set_value → press → verify updated semantic tree + PNG
→ start GTK test app
→ computer_elements(desktop) → set_value → press → verify updated AT-SPI tree + PNG
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
COMPUTER_CDP_ENDPOINTS=http://127.0.0.1:9222 # optional explicit opt-in existing Chrome/Electron sessions
COMPUTER_BROWSER_EXTENSION_HOME= # optional private extension/native-host state root
COMPUTER_BROWSER_SESSION_DIR= # optional private root for isolated browser profiles
COMPUTER_BROWSER_UPLOAD_ROOTS= # optional path-delimited allowlist; filesystem root is always ignored
COMPUTER_CHROME_EXECUTABLE=   # optional explicit Chrome/Chromium binary
NO_AT_BRIDGE=0                # Linux semantic accessibility
GTK_MODULES=gail:atk-bridge   # Linux GTK accessibility bridge
```
