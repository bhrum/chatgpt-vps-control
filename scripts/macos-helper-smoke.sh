#!/usr/bin/env bash
set -euo pipefail
xcrun swiftc native/macos/ComputerHelper.swift -o /tmp/chatgpt-computer-helper -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit
BASE=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"doctor":false}' | /tmp/chatgpt-computer-helper)
printf '%s\n' "$BASE"
python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["ok"] is True; assert "permissions" in data' <<<"$BASE"
SEMANTIC=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"includeElements":true,"elementOptions":{"maxElements":20}}' | /tmp/chatgpt-computer-helper)
printf '%s\n' "$SEMANTIC"
python3 -c 'import json,sys; data=json.load(sys.stdin); assert data.get("ok") is True or "Accessibility permission" in data.get("error", "")' <<<"$SEMANTIC"
echo 'macOS helper compile/protocol/permission-boundary smoke passed.'
