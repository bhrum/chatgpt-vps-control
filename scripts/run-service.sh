#!/bin/bash
# Foreground entrypoint for the chatgpt-computer-control systemd service.
# Starts Xvfb on :99 if needed, then execs the MCP/device-agent server.
set -u

APP_DIR="/home/hatch/workspace/chatgpt-vps-control"

EGRESS_PROXY="http://hatch-egress-proxy:3128"
export DISPLAY=":99"
export HTTP_PROXY="$EGRESS_PROXY" HTTPS_PROXY="$EGRESS_PROXY"
export http_proxy="$EGRESS_PROXY" https_proxy="$EGRESS_PROXY"
export no_proxy="${no_proxy:-localhost,127.0.0.1}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1}"

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset >>/tmp/xvfb.log 2>&1 &
fi

cd "$APP_DIR" || exit 1
exec node bin/chatgpt-computer-control.js serve
