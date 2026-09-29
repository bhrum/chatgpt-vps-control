#!/bin/bash
# Reinstall the chatgpt-computer-control systemd system service.
# Needed because a VM reboot/replacement on this host can wipe more than
# /etc: the unit file under /etc/systemd/system is ephemeral AND apt-installed
# desktop dependencies can disappear too (seen 2026-09-30: xfwm4, xdotool,
# wmctrl, x11-utils, python3-pyatspi, at-spi2-core all gone, service stuck in
# an auto-restart death loop with "Managed Linux desktop requires <dep>").
# This repo (~/workspace) is persistent; /usr and /etc are not.
# Run this after any reboot. Idempotent and safe to run anytime.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

# 1. Desktop dependencies the managed-linux desktop backend requires.
#    If any are missing the service start-loops with
#    "Managed Linux desktop requires <binary>" and reinstalling the unit
#    alone will NOT fix it.
DESKTOP_DEPS="xfwm4 xdotool wmctrl x11-utils python3-pyatspi at-spi2-core"
MISSING=""
for dep in $DESKTOP_DEPS; do
  dpkg -s "$dep" >/dev/null 2>&1 || MISSING="$MISSING $dep"
done
if [ -n "$MISSING" ]; then
  echo "Missing desktop deps:$MISSING — reinstalling via apt..." >&2
  # Package lists go stale across reboots; update first. This can take
  # ~5 min through the egress proxy and some mirrors may fail — enough
  # usually succeed, so don't abort on update errors.
  apt-get update 2>&1 | tail -2 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y $MISSING
fi

# 2. Restore the systemd unit (wiped from /etc on reboot).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 644 "$SCRIPT_DIR/chatgpt-computer-control.service" \
  /etc/systemd/system/chatgpt-computer-control.service
systemctl daemon-reload
systemctl enable --now chatgpt-computer-control.service
systemctl is-active chatgpt-computer-control.service
