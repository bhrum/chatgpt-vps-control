---
name: "service-watchdog"
description: "Keep the chatgpt-computer-control systemd service online across VM reboots on hosts where /etc is ephemeral: (re)install the unit file and run a watchdog hook that auto-restores it. Use when the device disappears from ChatGPT's device list, after any VM reboot/replacement, or when setting up the service on a new host."
---

# Service Watchdog

## Purpose

On this hosting setup `/etc` does not survive a reboot, so the systemd unit
for `chatgpt-computer-control` can vanish and the device (`htch-runtime`)
drops off ChatGPT's device list. This skill reinstalls the service and
installs a watchdog hook that checks it every 60 seconds and restores it
automatically. No manual commands are needed after a reboot.

## Workflow

1. **Reinstall the service** (idempotent, safe to run anytime):
   ```bash
   sudo ~/workspace/chatgpt-vps-control/scripts/install-systemd-service.sh
   ```
   This writes `scripts/chatgpt-computer-control.service` to
   `/etc/systemd/system/`, reloads systemd, and enables + starts the service.

2. **Install the watchdog script**:
   ```bash
   install -m 755 \
     ~/workspace/chatgpt-vps-control/skills/service-watchdog/assets/device-service-watchdog.sh \
     ~/hooks/scripts/device-service-watchdog.sh
   ```

3. **Register the hook** with `hooks.add`:
   - id: `device-service-watchdog`
   - script_path: `~/hooks/scripts/device-service-watchdog.sh`
   - poll_interval_secs: `60`
   - prompt: instruct the worker to read `/tmp/device-watchdog-install.log`,
     check `systemctl status` / `journalctl -u chatgpt-computer-control`,
     retry the installer as root, and verify the log line
     `Device agent connected to chatgpt-mcp.371080.xyz as htch-runtime`.
     Never print device credentials.

4. **Test**: `hooks.dry_run` (expect `silent`, reason `service active`),
   then stop the service (`systemctl stop chatgpt-computer-control`) and
   `hooks.run` (expect `silent`, reason `service restored`). Re-check
   `systemctl is-active`.

5. **Enable** with `hooks.enable`.

## Output Contract

Done means all three hold:
- `systemctl is-active chatgpt-computer-control` prints `active`.
- The hook `device-service-watchdog` is enabled and its log shows periodic
  `silent` / `service active` polls.
- `journalctl -u chatgpt-computer-control` contains a recent
  `Device agent connected to chatgpt-mcp.371080.xyz as htch-runtime`.

## Operating Rules

1. `/etc` is ephemeral here: never rely on anything under `/etc` (unit
   files, apt source edits) surviving a reboot. The repo (`~/workspace`)
   and `~` persist — keep every recovery artifact there.
2. A reboot can also wipe apt-installed packages under `/usr` (seen
   2026-09-30: `xfwm4`, `xdotool`, `wmctrl`, `x11-utils`,
   `python3-pyatspi`, `at-spi2-core` all gone). Without them the service
   start-loops with `Managed Linux desktop requires <binary>` and
   reinstalling the unit file alone does NOT fix it. The installer script
   (`scripts/install-systemd-service.sh`) now re-installs the desktop
   dependency set via apt before enabling the service — always recover
   through the installer, never by restoring the unit file alone.
   If `journalctl` shows `Managed Linux desktop requires …` after a
   reboot, the deps are the problem, not the unit file.
2. The service needs `CHATGPT_COMPUTER_HOME=/home/hatch/.chatgpt-computer-control`
   and `HOME=/home/hatch` in its environment, or it cannot find its config.
3. Use the credential-less egress proxy `http://hatch-egress-proxy:3128`.
   Proxy credentials rotate — never bake them into files (a stale credential
   causes HTTP 407).
4. Device credentials persist in `~/.chatgpt-computer-control/.env`
   (`DEVICE_ID`, `DEVICE_GATEWAY_TOKEN`, …). Reinstalling the service never
   requires re-enrollment. Never print these values.
5. The watchdog wakes a worker only when the reinstall itself fails.
   A proxy outage is host-side and cannot be fixed from inside the VM: the
   service keeps retrying (`Restart=always`) and the agent reconnects on its
   own once the proxy is back. See `references/runbook.md` for diagnosis.
