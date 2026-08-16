# Grok Bot computer-use port

## Source recovered

The Grok Bot 0.16.0 migration ledger identifies a recovered application source tree from the authorized application package. The recovered host bundle contains the original local X11 computer-use implementation under:

`dist/host/host-main.cjs/packages/local-exec/src/computer-use/`

The implementation inspected for this port includes `index.ts`, `computer-use.ts`, `x11-executor.ts`, `display.ts`, `types.ts`, `scaling.ts`, `shell.ts`, `input-event-logger.ts`, and `lazy-computer-use.ts`. The migration contract independently records recovered source hashes for `src/computer-use/index.ts` (`8c00b51a5d4f77f212c088c8ad95aabe2a94aaef57ac61f78e92b00316ec5989`) and `src/computer-use/computer-use.ts` (`7ac6751bb2738655c2ae498a6b4a01ef8669bec05c36367290634ee9a7782974`).

## Original mechanism

The recovered Grok Bot implementation is an OS-level X11 controller, not a DOM automation shim:

- `xdotool` performs mouse movement, click, drag, scrolling, key presses, and text entry.
- `xrandr` and `xdpyinfo` discover the live X11 display and its resolution.
- `ffmpeg` with `x11grab` captures the resulting screen.
- The model-facing coordinate system uses a 1280-pixel API width and scales to the actual display.
- A settle delay is applied before the returned screenshot after visual input actions.
- Unicode text that is not safely typeable through the current keymap can temporarily borrow unused X keycodes.

## Connector implementation

`computer-use.js` ports that mechanism into the installable connector and exposes three computer MCP tools:

- `computer_environment` (`vps.read`): reports the selected platform backend and readiness/permission state.
- `computer_state` (`vps.read`): returns the selected display, display/API resolution, cursor position, active/visible windows, and optionally an inline screenshot.
- `computer_use` (`vps.write`): supports `screenshot`, `click`, `move`, `drag`, `type`, `key`, `scroll`, and `wait`, plus up to nine known follow-up actions in `then`; one final inline screenshot is returned.

The port intentionally keeps input execution in direct child processes with argument arrays instead of interpolated shell strings.

## Improvements over the recovered runtime

The current connector version adds:

1. MCP-native separation between observation and mutation (`vps.read` vs `vps.write`).
2. Automatic X display selection: explicit `display`, then the connector process `DISPLAY`, then `:0` through `:9`.
3. Active-window and visible-window metadata alongside screenshots.
4. One-call batching for already-known action sequences, with one final screenshot.
5. Bounded action sizes, wait time, follow-up count, process output, and screenshot size.
6. Connector audit entries that summarize action kinds but deliberately do not store the text typed into the desktop.
7. Screenshot output as PNG to avoid the recovered ffmpeg pipe/WebP header repair requirement while preserving lossless UI capture.
8. Explicit coordinate bounds validation before sending events to X11.

## Runtime verification on 2026-08-16

The target VPS already provided `xdotool`, `xrandr`, `xdpyinfo`, `xmodmap`, `ffmpeg`, and active Xvfb displays. The connector process uses `DISPLAY=:3`, currently at 1280x800.

Verification completed against a temporary MCP instance and then the live PM2 process:

- MCP `tools/list` returns both `computer_state` and `computer_use`.
- `computer_state` returned display `:3`, API resolution `1280x800`, the current cursor, active window, and visible-window inventory.
- A low-impact `computer_use` mouse move from x=22 to x=23 at y=697 completed successfully.
- The same `computer_use` call returned one inline PNG screenshot of the resulting screen.
- The live PM2 MCP instance also returned a successful `computer_state` call after deployment.
- `node --check server.js`, `node --check computer-use.js`, `npm run check`, and `git diff --check` passed.

Current implementation SHA-256 at deployment time:

- `computer-use.js`: `aadcad24fd275ac4c2ef0c6d1274cb427ff547e5ceaccb805a5a0003a806d15f`
- `server.js`: `ac3c6240d5b13956ac935ad25dd28f4f372007a64f48f22ffb9a4406237743e0`

## ChatGPT connector schema refresh

The MCP server advertises the new tools immediately. An already-open ChatGPT conversation may retain the connector tool schema that was loaded before deployment; that cached conversation can continue to show only the older tool set until the connector/app schema is refreshed. A fresh tool discovery/reconnection should load the live ten-tool manifest.
## Cross-platform installer evolution

The installable 0.2.x architecture preserves the recovered X11 backend on Linux and adds platform-native adapters instead of emulating X11 on every OS:

- Linux: existing X11 session, or managed `Xvfb` + `xfwm4` when headless.
- macOS: a Swift CoreGraphics/AppKit/Accessibility helper compiled during setup.
- Windows: a PowerShell/C# helper using User32 `SendInput`, cursor/window APIs, and GDI screenshot capture.

The MCP API and normalized coordinates remain the same across all three backends. The server shell runner and SHA-256 implementation were also made cross-platform so installation does not leave non-computer tools Linux-only.
