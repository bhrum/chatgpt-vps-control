# Tool routing reference

## Standard sequence

1. Call `list_devices`.
2. Select one online `deviceId` and inspect its advertised capabilities.
3. Call `device_call` only for non-sensitive values.
4. Refresh semantic state after each meaningful mutation.
5. Verify the requested outcome, then clean up only automation-owned disposable resources.

## Browser decision table

| Need | Session/channel | First observation | Preferred action |
| --- | --- | --- | --- |
| Existing signed-in Chrome state | `extension` | `computer_browser_session` list, then snapshot | `computer_browser_locator` |
| Isolated background automation | `managed` | session list/start, then snapshot | locator; CUA only for visual surfaces |
| Existing loopback-debug browser | `attached` | session list, then snapshot | locator |
| Canvas or rich editor | any exact claimed session | snapshot plus page screenshot | `computer_browser_cua` |
| PDF/text export, logs, downloads, dialogs | any exact claimed session | session list | `computer_browser_utility` |

The extension is a transport for ordinary Chrome tabs. It is not equivalent to cloning a Chrome profile. A managed session is isolated and does not automatically share ordinary Chrome cookies. An attached session relies on an already-running browser with an explicitly exposed loopback DevTools endpoint.

For an existing tab action, always send the current `targetId` and `targetClaim`. Create a new automation tab instead of navigating a user-owned tab when the task can be completed separately. Never use cleanup to close user-owned tabs.

## Semantic state rules

- Browser `@ref` values belong to one `snapshotId`, session, target id, and target claim.
- Native element indexes belong to one recent `computer_elements` snapshot.
- Refresh after navigation, modal transitions, form submission, app-window changes, or any failed stale-state action.
- Do not retry stale claims or expired refs blindly. Relist and re-observe.
- Prefer role/name/CSS locators over coordinates for normal DOM controls.
- Prefer native AX element actions over app-scoped coordinates for normal controls.

## Low-interference defaults

- Leave `activate=false` and `activateApplication=false` unless foreground interaction is truly required.
- Use target-only browser capture and input instead of desktop screenshots and global input.
- Batch coherent actions, but do not batch past a state transition that must be observed.
- Keep the user's clipboard and active tab untouched unless a capability explicitly requires focus and the user has accepted that effect.

## Handoff and private input

For ordinary manual intervention, stop on the current target and tell the user exactly what must be completed. Refresh all claims and state after the user returns control.

For private input, call `render_sensitive_input` and queue steps with complete placeholder values such as `{{password}}` or `{{otp}}`. Do not log, echo, inspect, or forward the submitted plaintext. Cancel an obsolete challenge instead of creating ambiguous competing prompts.
