#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CHATGPT_COMPUTER_REPO_URL:-https://github.com/bhrum/chatgpt-vps-control.git}"
INSTALL_ROOT="${CHATGPT_COMPUTER_INSTALL_ROOT:-$HOME/.local/share/chatgpt-computer-control}"
SRC="$INSTALL_ROOT/src"
BIN_DIR="${CHATGPT_COMPUTER_BIN_DIR:-$HOME/.local/bin}"

need() { command -v "$1" >/dev/null 2>&1; }

if ! need git; then
  echo "git is required. Install git and rerun this installer." >&2
  exit 1
fi

if ! need node; then
  if [[ "$(uname -s)" == "Darwin" ]] && need brew; then
    brew install node
  elif need apt-get; then
    sudo apt-get update
    sudo apt-get install -y nodejs npm
  else
    echo "Node.js 20+ is required. Install Node.js, then rerun this installer." >&2
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20+ is required; found $(node --version). Upgrade Node.js and rerun." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
if [[ -d "$SRC/.git" ]]; then
  git -C "$SRC" fetch --all --prune
  git -C "$SRC" pull --ff-only
else
  rm -rf "$SRC"
  git clone "$REPO_URL" "$SRC"
fi

npm --prefix "$SRC" ci --omit=dev
chmod +x "$SRC/bin/chatgpt-computer-control.js"
ln -sfn "$SRC/bin/chatgpt-computer-control.js" "$BIN_DIR/chatgpt-computer-control"

export PATH="$BIN_DIR:$PATH"
"$BIN_DIR/chatgpt-computer-control" setup
"$BIN_DIR/chatgpt-computer-control" doctor || true
"$BIN_DIR/chatgpt-computer-control" service install

cat <<EOF

ChatGPT Computer Control installed.
CLI: $BIN_DIR/chatgpt-computer-control
Run: chatgpt-computer-control url

The URL is loopback-only by default. If ChatGPT is not running on this machine, expose the MCP only through an authenticated HTTPS tunnel or another trusted private transport.
EOF
