# Fabushi: unified device control versus local Computer Use

This comparison was performed on 2026-08-20 against the running Fabushi macOS app (`com.ombhrum.fabushi`). It records direct behavior observed through the authenticated unified-device route and the locally bundled Computer Use client, then maps each gap to this project's independent implementation.

## Observed behavior

| Area | Unified device control before this change | Local Computer Use | Implemented response |
| --- | --- | --- | --- |
| App targeting | Stable bundle id, background launch/read, and application-only screenshot worked | Stable app id and application-only screenshot worked | Retained stable identifiers and app-scoped capture |
| Accessibility tree | The observed Fabushi state contained only the application, window, one group, and two window buttons; the embedded web UI was absent | The same window exposed 47 structural/action lines: the WebView document, tabs, search field, session controls, composer, menu-bar headings, and other descendants | Best-effort `AXManualAccessibility`/`AXEnhancedUserInterface` enablement before traversal, deterministic child-source merging, unnamed container preservation, and complete-app traversal by default; inactive menu descendants and the system Apple menu are pruned |
| Semantic action | No semantic id existed for the visible Agent Host / 插件 Runtime controls, so coordinate fallback was required | The 插件 Runtime control was addressable by its current element index | `computer_use_bridge` keeps a short-lived per-app tree and rejects stale indexes after every write |
| Coordinate result | The click reached the correct control, but the fixed post-action delay captured an intermediate `Mahayana host request timed out: feature.info` state | The next state reflected the settled destination and a compact accessibility diff | Raw macOS actions now observe the target PID's AX events and wait for a bounded quiet window before capture |
| Background safety | App-scoped raw input was already PID-targeted, but semantic element click/scroll could still use the global event tap | Local Computer Use keeps the selected app/window as the action target | Semantic pointer and scroll events are now posted to the PID encoded in the fresh element snapshot |
| Remote contract | Remote callers had to compose separate application-state, element-action, and raw-coordinate tools | One app-scoped API exposes `list_apps`, `get_app_state`, `click`, `drag`, `press_key`, `type_text`, `scroll`, `set_value`, `select_text`, and `perform_secondary_action` | One authenticated `computer_use_bridge` operation surface mirrors those names and accepts the original snake-case action fields, while returning refreshed state and an image in the same call |

The bridge deliberately returns more safety information than the local API: snapshot expiry, the replacement snapshot id, screenshot scope and bounds, the semantic provider, and the coordinate-space label. Every write must echo the latest id through `snapshot_id`; the write consumes it and returns a new one, preventing an index or image coordinate from silently crossing UI generations. Values typed with `set_value` or `type_text` are not copied into audit history.

## Why the private Computer Use service is not forwarded

The distributed JavaScript client explicitly requires a trusted `nodeRepl.rpc("sky", ...)` host. Its native-pipe startup path also depends on trusted host metadata, Launch Services, and per-app policy. An arbitrary Node MCP process is therefore not an authorized client of that private service. Forwarding its socket or weakening sender checks would be brittle and would cross the local security boundary.

The remote mode is instead a compatible independent implementation behind the existing OAuth scopes, device gateway authentication, stale-snapshot checks, lock-screen guards, and encrypted sensitive-input route. It uses the same public operation vocabulary but does not impersonate or proxy the private service.

## Why macOS repeatedly asked Node to read protected folders

The installed LaunchAgent and Chrome Native Messaging launcher both pointed at JavaScript under the repository in `Documents`. The long-running executable was Homebrew Node, so macOS attributed each protected-folder read to `node`, not to the signed **ChatGPT Computer Control** helper. Replacing/upgrading Node or moving the checkout can make those decisions appear new again.

`service install` and `browser-extension install` now stage the executable package and dependencies into a content-addressed directory under `~/.chatgpt-computer-control/runtime/` and register only those private paths. Accessibility and Screen Recording remain owned by the signed helper app; routine background Node processes no longer need the repository under Documents.

## Verification boundary

Schema, source invariants, runtime staging, and JavaScript syntax are covered by lightweight tests. The existing GitHub Actions workflow type-checks and probes the macOS helper and exercises the compatibility bridge on the managed Linux/AT-SPI desktop, including an original snake-case semantic write and an application-screenshot coordinate click. Native compilation and end-to-end desktop tests are intentionally not run on the development machine.
