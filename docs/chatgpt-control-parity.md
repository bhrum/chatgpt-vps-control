# ChatGPT Computer Use and Browser parity map

This document records the design recovered from the locally installed, owner-authorized ChatGPT Computer Use and Browser plugins and maps it to this project's independent implementation. It is a behavior and architecture reconstruction, not a source-code copy.

## Recovered architecture

The desktop controller is a client/service design rather than a shell wrapper. The distributed `@oai/sky` JavaScript client connects over a persistent native pipe to the separately signed `com.openai.sky.CUAService` app. The service links AppKit, ApplicationServices, CoreGraphics, ScreenCaptureKit, WebKit, SwiftProtobuf, and XPC-related runtime libraries. Its visible metadata identifies cached/refetchable AX trees, window observation, UI-settle decisions, synthetic app focus enforcement, system focus-steal prevention, desktop-independent window capture, secondary accessibility actions, text selection, and lock-screen guarding. See [computer-use-reconstruction.md](computer-use-reconstruction.md) for the evidence mapping.

The effective desktop loop is:

```text
stable application target
→ full AX tree + screenshot (Skyshot)
→ element-index action, exact secondary AX action, or coordinate fallback
→ wait only when the UI indicates settling is needed
→ fresh/diffed AX tree + application-scoped screenshot
→ invalidate stale element indexes
```

The Browser plugin is a separate browser/session abstraction. Its public hierarchy is `Browsers → Browser → Tabs → Tab`, with tab-scoped AX, coordinate CUA, visible-DOM CUA, locator automation, clipboard, content export, screenshots, navigation, downloads, dialogs, and developer logs. Existing user tabs are first enumerated and then claimed from a fresh snapshot; the browser id, tab id, title, and URL are matched together so a recycled numeric id fails closed. Agent-created tabs have a lifecycle distinct from user tabs and can be retained as a deliverable or handoff.

The owner-authorized Chrome extension build `1.2.27236.6274` was also inspected locally as a behavioral reference. Its browser-control path separates a persistent profile instance id from an ephemeral browser generation, stores active tab leases in session storage, serializes debugger attachment, inherits newly created navigation targets from a controlled opener, groups agent-created tabs, restores connection state through native-host reconnect alarms, forwards CDP and download events, and distinguishes temporary, deliverable, and handoff cleanup. This project independently reimplements the applicable mechanisms with its own identifiers and protocol; unrelated ChatGPT side-panel, account, history, bookmark, notification, and content-script features are intentionally excluded.

## Project implementation

| Recovered behavior | Project implementation | Status |
| --- | --- | --- |
| Stable app discovery and targeting | `computer_applications`; native bundle/app ids, Win32 ids, desktop entries, AT-SPI ids, running state, and nullable OS-backed last-used/use-count metadata with deterministic relevance ordering | Implemented |
| Exact window lifecycle and geometry | `computer_window` consumes short-lived desktop/id/title-bound claims from `computer_state` and supports activate/close/minimize/maximize/restore/move-resize through macOS AX, Win32, or EWMH/X11, followed by refreshed state and capture | Implemented |
| App-scoped AX/UIA/AT-SPI state | `computer_app_state` with full first state, compact later diffs, target-window screenshot, desktop-coordinate crop bounds, and explicit desktop fallback scope | Implemented |
| Lazy embedded-web accessibility enablement | macOS primes `AXManualAccessibility` and `AXEnhancedUserInterface`, then deterministically merges children, navigation-order children, visible children, and contents before bounded traversal | Implemented |
| Short-lived element indexes | `computer_elements` snapshots expire after 90 seconds and are invalidated after writes | Implemented |
| Exact advertised secondary actions | `computer_element_secondary_action` rejects unadvertised native actions | Implemented |
| Element-first, coordinate fallback | semantic actions plus `computer_use` click/move/drag/type/key/scroll/wait | Implemented |
| One-call remote window API | `computer_use_bridge` mirrors the ten public window operations, accepts their original snake-case fields plus legacy camel-case aliases, translates the returned app screenshot on every platform, and returns refreshed state after writes | Implemented |
| Post-action capture and state refresh | stabilized same-application window capture with crop bounds or target-only CDP `Page.captureScreenshot`, explicit desktop fallback scope, replacement snapshot, refreshed/diffed state | Implemented |
| Element click semantics | exact element center, left/right/middle button, one to three clicks on macOS, Windows, Linux, and browser CDP | Implemented |
| Element scroll semantics | direction plus page count, positioned over the selected element on every platform | Implemented |
| Contextual text selection | `text` with optional `prefix`/`suffix`, plus text/cursor-before/cursor-after modes through AX, UIA, AT-SPI, or DOM selection | Implemented |
| macOS capture and input | ScreenCaptureKit with system fallback; AXUIElement and CoreGraphics events | Implemented |
| Browser target accessibility | CDP Accessibility + DOM metadata, stable target id and private backend-node handle | Implemented |
| Do not disturb ordinary tabs | separate user-data directory, separate browser process, loopback-only random DevTools port | Implemented |
| Explicit existing/signed-in browser attachment | operator-configured loopback CDP instances appear as `kind=attached`; exact browser/title/URL target claims gate navigation, locator, export, clipboard, logs, dialogs, downloads, and tab actions, while browser stop is prohibited | Implemented |
| Existing Chrome without a CDP launch flag | project-owned MV3 extension automatically enumerates eligible tabs; the MCP atomically claims an exact generation/id/title/URL tuple before `chrome.debugger` attaches. Native Messaging is allow-listed and authenticated over private local IPC, and sessions surface as synthetic `kind=extension` browsers | Implemented |
| Background operation without focus theft | extension/CDP tab work stays background; native app-state reads do not activate the app; macOS captures the target PID's desktop-independent window and posts app-window input directly to that PID. Foreground activation is explicit | Implemented |
| Background semantic pointer safety | macOS semantic element click and scroll post to the PID embedded in the current AX snapshot instead of the global event tap | Implemented |
| Chrome internal UI and OS dialogs | app-scoped AX/UIA plus native keyboard/mouse control handles `chrome://extensions` and native file choosers outside page CDP; filtered traversal is bounded by depth and visited-node limits | Implemented |
| Browser restart/reconnect identity | persistent project extension instance id plus session-scoped browser generation; generation participates in target claims, with heartbeat alarms and bounded reconnect backoff for Native Messaging | Implemented |
| Child tabs and automation organization | popups/new navigation targets inherit only from an already claimed or automation-owned opener; automation tabs use a named Chrome tab group and remain distinct from user tabs | Implemented |
| Exact target lifecycle and ownership | list/start/stop, navigate, new/activate/close tab, back/forward/reload/screenshot; existing tabs default to retained user ownership, while tool-created tabs and popups with a confirmed automation opener are temporary, retainable for handoff, releasable, and safely batch-cleanable | Implemented |
| Fail closed on stale target | each managed target returns a claim derived from the browser WebSocket identity, target id, title, and URL; every existing-tab action validates the fresh claim, and semantic element ids bind their snapshot title/URL | Implemented |
| Concurrent browser discovery | configured, managed, and conventional loopback endpoints probed concurrently | Implemented |
| Source-specific post-action screenshot | browser element writes return a page-only PNG without foregrounding another app | Implemented |
| Browser locator/DOM batch API | `computer_browser_locator` supports CSS/role/name/text locators, open shadow roots, up to eight nested same-origin or cross-origin frames via isolated CDP worlds, state waits, click/double-click, pointer/form/file-upload/element-drag/keyboard/scroll/attribute actions, and up to 20 declarative steps without arbitrary script evaluation; upload paths are canonicalized and confined to approved non-root directories | Implemented |
| Browser tab coordinate CUA | `computer_browser_cua` binds click/double-click/move/drag/type/keypress/scroll/media-download/wait batches to an exact target claim, supports modifier keys, explicit drag paths, raw deltas, clipped/full-page capture, uses page CSS-pixel coordinates rather than desktop coordinates, and returns one target-only screenshot | Implemented |
| Clipboard, downloads, dialogs, exports, logs | `computer_browser_utility` with target-scoped DOM/text export, bounded and atomically persisted PDF artifacts, origin-bound Clipboard API, buffered console/exception/Log events, JavaScript dialog handling, and browser-level download lifecycle | Implemented |
| Adaptive native UI settle/window observer | a process-lifetime JSON-lines service keeps target-scoped macOS AXObserver, Windows UIA structure/property/automation, or Linux AT-SPI object/window subscriptions alive; actions capture an event generation before mutation and wait for quiet afterward, with action-scoped observers and DOM/state fingerprints as fallbacks | Implemented |
| Native service/process isolation | Node uses a restartable process-lifetime, size- and timeout-bounded JSON-lines broker in the signed macOS app bundle or Windows helper; individual requests execute in isolated children and transport failure falls back to the established one-shot path without retrying helper-reported mutations | Implemented |
| Protected-folder-free Node launchers | service and Chrome Native Messaging installs run a content-addressed private copy under the connector home rather than JavaScript in Desktop/Documents/Downloads | Implemented |
| macOS persistent native transport | signed process-lifetime broker with bounded JSON-lines requests, isolated per-action children, hot ScreenCaptureKit window cache, plus an embedded mutually authenticated XPC compatibility service | Implemented |
| Lock-screen guardian/manual handoff | native input fails closed on locked, inactive, disconnected, or secure desktops; encrypted sensitive-input handoff already exists | Implemented |

## Isolation guarantees

Managed browser sessions are stored under a private per-session directory (default `~/.chatgpt-computer-control/browser-sessions/<name>`). Chrome receives that directory via `--user-data-dir`, binds DevTools to `127.0.0.1`, and chooses an ephemeral port. All tab actions are re-scoped to the endpoint read from that session's own `DevToolsActivePort`; the browser WebSocket identity, target id, title, URL, and current target claim must still match. A recycled port, browser process, tab id, or navigated page therefore fails closed until the caller refreshes the session and uses its new claim. URLs are restricted to `http`, `https`, `data`, and `about:blank`, preventing the remote tool from using privileged `file`, `chrome`, `devtools`, or `javascript` schemes. Persistent observers exist only for targets in these managed sessions and are destroyed when the tab or session closes.

Closing a tab or browser in a managed session affects only its dedicated profile. Ordinary browser state is neither discovered nor touched unless the separate extension is installed. Once installed, it enumerates ordinary webpage tab metadata like the reference plugin, while debugger attachment occurs only after the MCP selects and atomically claims a fresh generation/id/title/URL tuple. Both existing-browser routes require exact claims and refuse to stop the user's browser. The extension/native-host protocol was independently implemented from observed behavior and public Chrome APIs, without copying plugin source or using OpenAI extension identities.

## Verification contract

Lightweight unit tests validate tool schemas, session-name path safety, upload-root confinement, symlink escape rejection, URL-scheme policy, stable generated extension identity, Native Messaging origin allow-listing, private bridge authentication, request correlation, and extension-backed CDP utility routing. The GitHub Actions managed-desktop job launches a real isolated Chrome session and exercises exact-target navigation, target-only screenshots, back, forward, reload, a role/CSS locator batch including a real file input, live text/HTML export, clipboard round trips, buffered console logs, JavaScript dialog dismissal, download completion, tab creation, activation, closure, and session shutdown. The same job then runs the existing CDP accessibility interaction and native AT-SPI interaction tests.

Heavy native, browser, and managed-desktop verification belongs in GitHub Actions; local verification is limited to syntax, schema, and side-effect-free unit checks.
