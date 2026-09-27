#!/bin/bash
# Keep the ChatGPT computer-control stack alive: Xvfb (:99) + MCP/device-agent.
# Used by cron @reboot and by a periodic watchdog.
#
# Proxy note: this VM reaches the internet through an egress proxy whose
# credentials rotate. The device agent's wss: connection works through the
# proxy WITHOUT credentials (stale credentials get a 407), so we always use
# the credential-less proxy URL here and never bake credentials into a file.
set -u

APP_DIR="/home/hatch/workspace/chatgpt-vps-control"
XVFB_LOG="/tmp/xvfb.log"
SERVE_LOG="/tmp/chatgpt-serve.log"

EGRESS_PROXY="http://hatch-egress-proxy:3128"
export DISPLAY=":99"
export HTTP_PROXY="$EGRESS_PROXY" HTTPS_PROXY="$EGRESS_PROXY"
export http_proxy="$EGRESS_PROXY" https_proxy="$EGRESS_PROXY"
# Preserve any no_proxy the environment already has.
export no_proxy="${no_proxy:-localhost,127.0.0.1}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1}"

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  nohup Xvfb :99 -screen 0 1280x800x24 >>"$XVFB_LOG" 2>&1 &
fi

if ! pgrep -f "chatgpt-computer-control.js [s]erve" >/dev/null 2>&1; then
  cd "$APP_DIR" || exit 1
  nohup node bin/chatgpt-computer-control.js serve >>"$SERVE_LOG" 2>&1 &
fi
