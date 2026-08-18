# Independent computer-use architecture

This project implements a new cross-platform computer-control engine from an observable behavior contract. It does not depend on the original computer-use application bundle at runtime.

## Reconstructed behavior contract

The client first chooses an application, reads the current application state, acts on an indexed element or screenshot coordinate, and reads state again. Application and element snapshots are short-lived because native accessibility handles can become stale after any UI mutation. Every write returns a fresh screenshot and invalidates the element snapshot. Exact secondary actions must have been advertised by the selected element; callers cannot invent an action name.

Application state is session-aware. The first read returns the complete normalized tree. Later reads for the same stable application identifier return additions, changes, and removals unless diffing is explicitly disabled.

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
- Cross-platform CI exercises macOS helper compilation, Windows UI Automation, Linux AT-SPI, and browser CDP behavior.
- macOS TCC requests originate from a stable named app bundle (`com.bhrum.computer-control`) rather than an anonymous Node/CLI process.
- Node communicates with the app through private one-shot request/response files and LaunchServices, so the protected API caller and TCC responsibility remain with the named app.

## Platform limits

Accessibility frameworks do not expose identical capabilities. macOS AX action names, Windows UIA patterns, and Linux AT-SPI action names are preserved as native secondary actions while the common operations are normalized. Wayland does not permit general global input/screen capture in the same way as X11; the current physical-Linux backend therefore requires X11, while managed VPS sessions use a private Xvfb desktop.
