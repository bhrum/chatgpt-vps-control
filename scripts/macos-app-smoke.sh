#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$RUNNER_TEMP/ChatGPT Computer Control.app"
EXECUTABLE="$APP_ROOT/Contents/MacOS/ChatGPTComputerControl"
XPC_ROOT="$APP_ROOT/Contents/XPCServices/com.bhrum.computer-control.request-service.xpc"
XPC_EXECUTABLE="$XPC_ROOT/Contents/MacOS/ChatGPTComputerRequestService"
TARGET_ARCH="$(uname -m)"
mkdir -p "$APP_ROOT/Contents/MacOS" "$APP_ROOT/Contents/Resources" "$XPC_ROOT/Contents/MacOS"
cp native/macos/Info.plist "$APP_ROOT/Contents/Info.plist"
cp native/macos/RequestService-Info.plist "$XPC_ROOT/Contents/Info.plist"
xcrun swiftc -target "$TARGET_ARCH-apple-macos14.0" native/macos/ComputerHelper.swift -o "$EXECUTABLE" -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit
xcrun swiftc -D REQUEST_XPC_SERVICE -target "$TARGET_ARCH-apple-macos14.0" native/macos/ComputerHelper.swift -o "$XPC_EXECUTABLE" -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit
chmod 755 "$EXECUTABLE" "$XPC_EXECUTABLE"
codesign --force --sign - --identifier com.bhrum.computer-control.request-service "$XPC_ROOT"
codesign --force --sign - --identifier com.bhrum.computer-control "$APP_ROOT"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$APP_ROOT/Contents/Info.plist")" = 'ChatGPT Computer Control'
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_ROOT/Contents/Info.plist")" = 'com.bhrum.computer-control'
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$XPC_ROOT/Contents/Info.plist")" = 'com.bhrum.computer-control.request-service'
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' "$XPC_ROOT/Contents/Info.plist")" = 'XPC!'
codesign --verify --deep --strict "$APP_ROOT"
codesign --verify --strict "$XPC_ROOT"
codesign -d --verbose=4 "$XPC_ROOT" 2>&1 | grep 'Identifier=com.bhrum.computer-control.request-service'
otool -l "$EXECUTABLE" | awk '/minos / { found=1; if ($2 != "14.0") bad=1 } END { exit (!found || bad) }'
OBSERVER=$(printf '%s\n' '{"id":1,"command":"ping"}' | "$EXECUTABLE" --observer-server)
python3 -c 'import json,sys; data=json.load(sys.stdin); assert data == {"id":1,"ok":True,"source":"macos-ax-service"}' <<<"$OBSERVER"
REQUEST_SERVICE=$(printf '%s\n' '{"id":2,"command":"request","payload":{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"doctor":false}}' | "$EXECUTABLE" --request-server)
python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["id"] == 2 and data["ok"] is True and data["result"]["ok"] is True and data["transport"] == "persistent-broker"' <<<"$REQUEST_SERVICE"
BASE=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"doctor":false}' | "$EXECUTABLE")
python3 -c 'import json,sys; data=json.load(sys.stdin); p=data["permissions"]; assert data["ok"] is True; assert isinstance(p["interactiveDesktop"], bool); assert isinstance(p["screenLocked"], bool)' <<<"$BASE"
REQUEST_FILE="$RUNNER_TEMP/computer-helper-request.json"
RESPONSE_FILE="$RUNNER_TEMP/computer-helper-response.json"
printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"doctor":false}' > "$REQUEST_FILE"
/usr/bin/open -n -W "$APP_ROOT" --args --request-file "$REQUEST_FILE" --response-file "$RESPONSE_FILE"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); p=data["permissions"]; assert data["ok"] is True; assert isinstance(p["interactiveDesktop"], bool); assert isinstance(p["screenLocked"], bool)' "$RESPONSE_FILE"
APPLICATIONS=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"listApplications":true}' | "$EXECUTABLE")
python3 -c 'import json,sys; data=json.load(sys.stdin); apps=data.get("applications", []); assert data["ok"] is True; assert isinstance(apps, list); assert all({"id", "displayName", "path", "isRunning", "lastUsedDate", "useCount"} <= set(app) for app in apps)' <<<"$APPLICATIONS"
SEMANTIC=$(printf '%s' '{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false,"includeElements":true,"elementOptions":{"maxElements":20}}' | "$EXECUTABLE")
python3 -c 'import json,sys; data=json.load(sys.stdin); assert data.get("ok") is True or "Accessibility permission" in data.get("error", "")' <<<"$SEMANTIC"
echo 'macOS named app bundle/signature/LaunchServices/protocol/permission-boundary smoke passed.'
