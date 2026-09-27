#!/usr/bin/env bash
# Watchdog: keep the chatgpt-computer-control systemd service online.
# /etc does not survive a reboot on this host, so the unit file can vanish;
# this hook reinstalls and restarts it automatically. Wakes a worker only
# when the reinstall itself fails.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

SERVICE="chatgpt-computer-control.service"
INSTALLER="/home/hatch/workspace/chatgpt-vps-control/scripts/install-systemd-service.sh"
INSTALL_LOG="/tmp/device-watchdog-install.log"

if systemctl is-active --quiet "$SERVICE"; then
  silent "service active" '{"service":"chatgpt-computer-control"}'
else
  if [ "$(id -u)" -ne 0 ]; then
    wake "service down and no root to reinstall" '{"service":"chatgpt-computer-control"}'
  elif [ ! -x "$INSTALLER" ]; then
    wake "service down and installer missing" '{"service":"chatgpt-computer-control"}'
  elif "$INSTALLER" >"$INSTALL_LOG" 2>&1 && systemctl is-active --quiet "$SERVICE"; then
    log "service restored after reinstall" '{"service":"chatgpt-computer-control"}'
    silent "service restored" '{"service":"chatgpt-computer-control"}'
  else
    wake "service reinstall failed" '{"service":"chatgpt-computer-control","install_log":"/tmp/device-watchdog-install.log"}'
  fi
fi
