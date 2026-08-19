# Independent computer-use architecture

This project implements a new cross-platform computer-control engine from an observable behavior contract. It does not depend on the original computer-use application bundle at runtime.

## Reconstructed behavior contract

The client first chooses an application, reads the current application state and screenshot, then acts on an indexed element or screenshot coordinate. Application and element snapshots are short-lived because native accessibility handles can become stale after any UI mutation. Before a native semantic write, the provider subscribes to its target application's AXObserver, UI Automation, or AT-SPI event stream; after mutation it waits for a quiet window and reports the source, duration, and observed event count. If event subscription is unavailable, the client polls normalized UI fingerprints instead. Every semantic write invalidates the old element snapshot and returns a replacement snapshot with refreshed/diffed state plus a fresh screenshot when capture permission is available. Exact secondary actions must have been advertised by the selected element; callers cannot invent an action name. Element actions cover exact multi-button clicks, direction/page scrolling, value changes, and contextual text or cursor selection in addition to native press/focus/range behaviors.

Application-state captures are window scoped when the target platform exposes a valid active-window rectangle: macOS uses AX window geometry with native region capture, Windows uses UIA/Win32 bounds with GDI region capture, and Linux uses the active AT-SPI window with an X11 region grab. The response includes the crop's desktop-coordinate bounds. Native element and secondary actions reuse that same provider-scoped capture only after their event/fingerprint settle phase, so the image and replacement semantic snapshot describe one stabilized application state. If no trustworthy application rectangle is available, the provider reports a `desktop` screenshot scope explicitly rather than implying that unrelated windows were excluded.

Browser work can start a named isolated session. Each such session gets its own Chrome/Chromium process, private user-data directory, loopback-only ephemeral DevTools endpoint, and exact target ids. It can also attach to a loopback endpoint listed in `COMPUTER_CDP_ENDPOINTS`, or use the optional MV3 extension to reach ordinary tabs in an already-signed-in Chrome that was not launched with CDP. The extension design is `enumerate ordinary tabs → select from a fresh snapshot → atomically verify generation/id/title/URL → claim exact tab → attach chrome.debugger → authenticated Native Messaging/private IPC`. Enumeration alone never attaches the debugger and no cookies or profile data are exported. Attached and extension instances receive synthetic identities and cannot be stopped through the API. Existing tabs default to retained user ownership. Tabs created through this API receive automation ownership and start temporary, may be retained for handoff, and are the only tabs eligible for batch cleanup. In every mode, content export, locators, navigation, CUA and tab actions require the current claim. `computer_browser_cua` sends bounded input batches in page CSS pixels, never desktop coordinates.

PDF export is target-claim scoped and uses Chrome's print pipeline rather than page-provided download code. A result is accepted only when it is non-empty, at most 64 MiB, and begins with the PDF signature. It is written with private permissions to a unique temporary file and atomically renamed inside the session `exports` directory, never overwriting an existing artifact. Session downloads and exports are both valid roots for a later restricted file-input action.

Native semantic actions use a narrow process-lifetime observer protocol rather than a general command shell. The Node client derives the target solely from the opaque element identity, requests an event-generation baseline, runs the existing identity-checked action helper, and then waits for a bounded quiet window. The observer accepts only `ping`, `watch`, `wait`, and `unwatch`; malformed targets and stale application roots fail closed. A service failure transparently returns control to the action-scoped observer and state-fingerprint settle paths.

General native requests use a second process-lifetime broker. Its protocol accepts only a bounded `request` envelope, applies a 1 MiB request and 24 MiB response limit, and gives every call a 65-second deadline. On macOS the signed broker executes each action request in an isolated same-identity child, but retains the ScreenCaptureKit window catalog and screenshot capture in the persistent process so background window capture stays hot. The app also embeds a separately signed `com.bhrum.computer-control.request-service.xpc` compatibility service whose peers enforce code-signing identifiers. Windows uses the equivalent persistent PowerShell broker and isolated child boundary. Broker death is detected and restarted automatically; only transport failures fall back to the established one-shot path, while a helper-reported action error is returned directly and is never retried.

Application state is session-aware. The first read returns the complete normalized tree. Later reads for the same stable application identifier return additions, changes, and removals unless diffing is explicitly disabled.

Window management is separate from element and coordinate input. `computer_state` supplies each current platform window id with a short-lived claim bound to desktop, id, and title; `computer_window` requires both for activation, close, minimize, maximize, restore, or normalized move/resize. macOS resolves the CoreGraphics id back to the owning AX window, Windows validates the HWND and title, and Linux verifies the X11 id and title before requesting the window manager action. Claims remain usable to restore a just-minimized window, while a recycled handle with a different identity fails closed. The result includes refreshed visible windows and a screenshot; a post-action capture failure never converts an already successful window mutation into an apparent failure.

## Native providers

| Platform | Discovery and state | Semantic actions | Visual fallback |
| --- | --- | --- | --- |
| macOS | named, signed app bundle + NSWorkspace + AXUIElement | AX actions and settable attributes | CoreGraphics/AppKit |
| Windows | Start Apps/process inventory + UI Automation | Invoke, SelectionItem, Toggle, ExpandCollapse, RangeValue, ScrollItem and Value patterns | User32/GDI |
| Linux | freedesktop `.desktop` entries + AT-SPI | Action, Component, EditableText and Value interfaces | X11 tools |
| Chrome/Electron | DevTools targets + full accessibility tree/DOM metadata | DOM focus, click, value and range operations | native desktop screenshot |

## Improvements over the observed contract

- One MCP tool surface and normalized element schema on macOS, Windows, Linux, Chrome, and Electron.
- Stable application IDs instead of relying on the frontmost window.
- Full-tree-first and compact-diff-later application sessions.
- Rich element metadata: hierarchy depth, native class/subrole, automation identifier, placeholder, URL, bounds, states, semantic actions, and exact native actions.
- Server-side short-lived snapshots hide native handles and reject stale or unadvertised actions.
- Native semantic control is preferred, with coordinate control retained as a fallback.
- Coordinate fallback is application-targeted on all three desktop platforms; Linux resolves and activates AT-SPI or freedesktop application identifiers before input.
- Input fails closed when macOS has no unlocked console CGSession, Windows exposes a locked/disconnected/secure input desktop, or logind marks a physical Linux session inactive or locked.
- Successful semantic actions are not reported as failed merely because post-action screen capture permission is unavailable; the refreshed accessibility state remains authoritative and prevents unsafe retries.
- Cross-platform CI exercises macOS helper compilation, Windows UI Automation, Linux AT-SPI, and browser CDP behavior.
- macOS TCC requests originate from a stable named app bundle (`com.bhrum.computer-control`) rather than an anonymous Node/CLI process.
- Node communicates with the app through private one-shot request/response files and LaunchServices, so the protected API caller and TCC responsibility remain with the named app.

## Platform limits

Accessibility frameworks do not expose identical capabilities. macOS AX action names, Windows UIA patterns, and Linux AT-SPI action names are preserved as native secondary actions while the common operations are normalized. Wayland does not permit general global input/screen capture in the same way as X11; the current physical-Linux backend therefore requires X11, while managed VPS sessions use a private Xvfb desktop.
