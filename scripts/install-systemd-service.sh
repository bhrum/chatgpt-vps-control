#!/bin/bash
# Reinstall the chatgpt-computer-control systemd system service.
# Needed because /etc does not survive a VM reboot/replacement on this host:
# the unit file under /etc/systemd/system is ephemeral, while this repo
# (~/workspace) is persistent. Run this after any reboot that wipes /etc.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 644 "$SCRIPT_DIR/chatgpt-computer-control.service" \
  /etc/systemd/system/chatgpt-computer-control.service
systemctl daemon-reload
systemctl enable --now chatgpt-computer-control.service
systemctl is-active chatgpt-computer-control.service
