# Computer Use reconstruction evidence

This document records behavior reconstructed from the locally installed ChatGPT Computer Use distribution. It separates directly observed evidence from this project's implementation so that compatibility work is not based on guesses.

## Installed artifacts inspected

- `@oai/sky` package version `0.6.16`, including its distributed JavaScript, TypeScript declarations, and generated API documentation.
- `Codex Computer Use.app` / `SkyComputerUseService`, bundle id `com.openai.sky.CUAService`, build `26.817.1000761`.
- The service's packaged Bazel manifest, Mach-O imports, Swift/Objective-C metadata, and runtime behavior through the public `sky` API.
- The installed ChatGPT Chrome extension's Manifest V3 package and background service worker.

## Confirmed architecture

1. The JavaScript client keeps one transport per API version. It connects to a persistent user-only native pipe at the CUA service app-group path, sends length-prefixed JSON-RPC frames, pings the service, enforces an 8 MiB frame bound, and restarts the service through the trusted host when necessary.
2. App state and actions are app-scoped. Requests carry an app identifier; element actions carry a short-lived element id derived from the latest app state. Coordinate click and drag use app-window screenshot coordinates rather than whole-desktop coordinates.
3. The native service is a background `LSUIElement` application. Its binary imports AppKit, ApplicationServices, CoreGraphics, ScreenCaptureKit, WebKit, ScriptingBridge, and XPC-related runtimes.
4. Binary metadata exposes `RefetchableSkyshotAXTree`, accessibility-tree invalidation monitors, window-ordering and focused-element observers, `SyntheticAppFocusEnforcer`, `SystemFocusStealPreventer`, accelerated window screenshots, and `SCContentFilter(desktopIndependentWindow:)` use. This confirms that background window capture and focus-steal prevention are deliberate service features.
5. The result formatter supports full trees, incremental diffs, cumulative diffs, selected text, focused elements, and app-specific instructions. Screenshot files are returned separately from accessibility text.
6. Browser control uses a separate extension/CDP path: ordinary tabs are enumerated first, then an exact current tab is claimed before debugger attachment. Browser-internal UI and native dialogs remain desktop-service responsibilities.
7. The distributed `sky.js` refuses its host-routed mode unless `nodeRepl.rpc` is present and reports that Computer Use requires a trusted Node REPL Sky service. The native-pipe path additionally depends on trusted host metadata and per-app approval. A general MCP process is not an authorized client of that private transport.
8. Native service metadata contains `AXManualAccessibility`, `AXEnhancedUserInterface`, `AXVisibleChildren`, and accessibility-enablement symbols. Combined with the observed Fabushi tree difference, this supports explicitly enabling lazy embedded-web accessibility before traversal.

## Project mapping

- Persistent authenticated local services: `lib/native-request-service.js`, the signed macOS helper/XPC service, and the browser Native Messaging bridge.
- Background app state: AX traversal targets an app's focused window without activating the app.
- Background screenshot: ScreenCaptureKit matches the target PID and captures its desktop-independent window, including when occluded.
- Background macOS input: app-window coordinates are translated to screen space, then CoreGraphics events are posted directly to the target PID. Explicit foreground activation remains opt-in.
- Focus-safe semantics: indexed AX press, value, selection, scrolling, and secondary actions operate on the target app without global focus changes.
- Tree freshness: bounded traversal, short-lived indexed snapshots, event-driven invalidation/settling, and optional act-then-observe calls.
- Existing signed-in Chrome: automatic tab enumeration, atomic claim, serialized debugger access, heartbeat/reconnect, tab grouping, child-tab inheritance, and user/automation ownership.
- Remote compatibility: `computer_use_bridge` implements the public window-operation contract independently behind the authenticated device gateway; it does not proxy the private Sky pipe.
- Protected-folder isolation: service and browser-host launchers execute a content-addressed package copy from the connector's private application-data directory.

## Limits of source recovery

Distributed JavaScript and declarations are readable build artifacts. Optimized native binaries do not contain the original comments, local variable names, or full pre-build project layout. Native implementation details are therefore reconstructed from stable metadata, linked APIs, packaged build manifests, and observed behavior; claims that cannot be supported by those artifacts are not treated as facts.
