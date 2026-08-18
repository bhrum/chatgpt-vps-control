#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$RUNNER_TEMP/ChatGPT Computer Control.app"
EXECUTABLE="$APP_ROOT/Contents/MacOS/ChatGPTComputerControl"
mkdir -p "$APP_ROOT/Contents/MacOS" "$APP_ROOT/Contents/Resources"
cp native/macos/Info.plist "$APP_ROOT/Contents/Info.plist"
xcrun swiftc native/macos/ComputerHelper.swift -o "$EXECUTABLE" -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit
codesign --force --deep --sign - --identifier com.bhrum.computer-control "$APP_ROOT"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$APP_ROOT/Contents/Info.plist")" = 'ChatGPT Computer Control'
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_ROOT/Contents/Info.plist")" = 'com.bhrum.computer-control'
codesign --verify --deep --strict "$APP_ROOT"
BASE=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"doctor":false}' | "$EXECUTABLE")
python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["ok"] is True; assert "permissions" in data' <<<"$BASE"
REQUEST_FILE="$RUNNER_TEMP/computer-helper-request.json"
RESPONSE_FILE="$RUNNER_TEMP/computer-helper-response.json"
printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"doctor":false}' > "$REQUEST_FILE"
/usr/bin/open -n -W "$APP_ROOT" --args --request-file "$REQUEST_FILE" --response-file "$RESPONSE_FILE"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["ok"] is True; assert "permissions" in data' "$RESPONSE_FILE"
APPLICATIONS=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"listApplications":true}' | "$EXECUTABLE")
python3 -c 'import json,sys; data=json.load(sys.stdin); apps=data.get("applications", []); assert data["ok"] is True; assert apps; assert all({"id", "displayName", "path", "isRunning", "pid"} <= set(app) for app in apps)' <<<"$APPLICATIONS"
SEMANTIC=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"includeElements":true,"elementOptions":{"maxElements":20}}' | "$EXECUTABLE")
python3 -c 'import json,sys; data=json.load(sys.stdin); assert data.get("ok") is True or "Accessibility permission" in data.get("error", "")' <<<"$SEMANTIC"
echo 'macOS named app bundle/signature/LaunchServices/protocol/permission-boundary smoke passed.'
