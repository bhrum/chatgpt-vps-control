---
name: unified-device-control
description: Control online computers through the Unified Device Control MCP with exact-device routing, background-first browser and native-app interaction, semantic snapshots, short-lived refs, safe sensitive-input handoff, and minimal disruption to the user's active desktop. Use for remote computer, browser-tab, desktop-app, cross-device, or unattended-device tasks.
---

# Unified Device Control

Use the Unified Device Control MCP as the transport. Call `list_devices` first, select one online device explicitly, and only call capabilities advertised by that device.

## Route each task

Choose the least disruptive capable surface in this order:

1. A purpose-built connector or application-internal API, when one already covers the task.
2. Browser semantic control on one exact claimed tab: `computer_browser_session`, then `computer_browser_snapshot` and `computer_browser_locator`.
3. Native accessibility: `computer_app_state` or `computer_elements`, then `computer_element_action` or an advertised secondary action, keeping activation disabled.
4. Target-only browser coordinates with `computer_browser_cua` for canvas or visually rendered browser surfaces.
5. App-scoped `computer_use` on macOS with `activateApplication=false`.
6. Foreground desktop coordinates only when the user explicitly accepts interruption or no background route works.

Read [references/tool-routing.md](references/tool-routing.md) before a multi-step browser task, a user handoff, or any action involving login state or sensitive input.

## Browser workflow

Call `computer_browser_session` with `action=list` before selecting a session or tab. Preserve the exact `session`, `targetId`, and `targetClaim` returned by the latest list. Claims fail closed when a target changes.

Select the session type deliberately:

- `extension`: reuse ordinary signed-in Chrome tabs shared through the installed extension. Never close a user-owned tab. Prefer creating an automation-owned tab for navigation or mutation.
- `managed`: use a dedicated isolated Chrome/Chromium profile. It does not automatically inherit the user's ordinary Chrome login state.
- `attached`: use only an explicitly configured loopback CDP browser. Treat its existing tabs as user-owned unless the MCP reports otherwise.

For ordinary web pages, take `computer_browser_snapshot`, inspect the compact semantic tree, and act with `computer_browser_locator`. A snapshot `@ref` is valid only with its `snapshotId` and exact target claim. Refresh the snapshot after navigation, submission, modal changes, or DOM rerenders. Prefer stable role/name/CSS locators for references that must survive refreshes.

Use `computer_browser_cua` only for canvas, rich editors, maps, virtualized controls, or incomplete semantics. Its coordinates are page CSS pixels, not desktop coordinates. Verify every meaningful mutation with a fresh snapshot, screenshot, export, or readback.

## Native application workflow

Inspect with `computer_app_state` or `computer_elements` without activating the app. Prefer element-index actions over coordinates and use only secondary actions explicitly advertised by the fresh element snapshot. Refresh after every UI-changing action because indexes are short-lived.

On macOS, app-scoped raw input may stay in the background when `activateApplication=false`. Do not set it to true merely to simplify targeting. If a platform cannot deliver background raw input, return to semantic element actions before considering foreground control.

## Ownership and handoff

Do not take over, activate, close, or repurpose a user-owned tab or window without need. Automation-created tabs default to disposable; retain one only when the user asks to continue manually or needs the live result. Clean up disposable automation tabs after verified completion.

If the user takes control, the target becomes inactive, or a handoff is required for login, CAPTCHA, permission, or manual review, stop acting on that surface. Resume only after the user says to continue, then refresh the device, session, target claim, and semantic state.

## Sensitive values

Never place passwords, OTPs, API keys, payment data, personal information, account choices, or consent in `device_call` arguments. Use `render_sensitive_input` with exact `{{fieldId}}` placeholders in the queued steps. The model must never call the widget-only submission endpoint or receive plaintext values.

## Unattended presence

An online pre-login macOS device may advertise only `device_presence`. Treat that as transport health, not an interactive desktop. Browser and desktop control require a usable logged-in session; never claim that pre-login presence bypasses macOS session security.
