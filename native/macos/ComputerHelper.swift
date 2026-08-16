import Foundation
import AppKit
import ApplicationServices

struct Point: Codable { let x: Int; let y: Int }
struct WindowInfo: Codable { let id: String; let name: String }
struct Resolution: Codable { let width: Int; let height: Int }
struct Action: Codable {
    let action: String
    let x: Int?
    let y: Int?
    let x2: Int?
    let y2: Int?
    let path: [Point]?
    let text: String?
    let key: String?
    let button: String?
    let count: Int?
    let direction: String?
    let amount: Int?
    let durationMs: Int?
}
struct Request: Codable {
    let apiWidth: Int?
    let actions: [Action]?
    let includeScreenshot: Bool?
    let includeWindows: Bool?
    let doctor: Bool?
}
struct Permissions: Codable { let accessibility: Bool; let screenRecording: Bool }
struct Response: Codable {
    let ok: Bool
    let error: String?
    let displayResolution: Resolution?
    let apiResolution: Resolution?
    let cursorPosition: Point?
    let activeWindow: WindowInfo?
    let windows: [WindowInfo]?
    let screenshotMimeType: String?
    let screenshotBase64: String?
    let permissions: Permissions?
}

func fail(_ message: String) -> Never {
    let response = Response(ok: false, error: message, displayResolution: nil, apiResolution: nil, cursorPosition: nil, activeWindow: nil, windows: nil, screenshotMimeType: nil, screenshotBase64: nil, permissions: nil)
    let data = try! JSONEncoder().encode(response)
    FileHandle.standardOutput.write(data)
    exit(0)
}

func screenRecordingAllowed(prompt: Bool = false) -> Bool {
    if #available(macOS 10.15, *) {
        if CGPreflightScreenCaptureAccess() { return true }
        if prompt { return CGRequestScreenCaptureAccess() }
        return false
    }
    return true
}

func accessibilityAllowed(prompt: Bool = false) -> Bool {
    if !prompt { return AXIsProcessTrusted() }
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func mainResolution(apiWidth: Int) -> (display: Resolution, api: Resolution) {
    let displayID = CGMainDisplayID()
    let w = Int(CGDisplayPixelsWide(displayID))
    let h = Int(CGDisplayPixelsHigh(displayID))
    let apiHeight = Int((Double(apiWidth) / (Double(w) / Double(h))).rounded())
    return (Resolution(width: w, height: h), Resolution(width: apiWidth, height: apiHeight))
}

func scale(_ point: Point, display: Resolution, api: Resolution) -> CGPoint {
    let x = Double(point.x) / Double(api.width) * Double(display.width)
    let y = Double(point.y) / Double(api.height) * Double(display.height)
    return CGPoint(x: x.rounded(), y: y.rounded())
}

func apiPoint(_ point: CGPoint, display: Resolution, api: Resolution) -> Point {
    let x = Int((point.x / Double(display.width) * Double(api.width)).rounded())
    let y = Int((point.y / Double(display.height) * Double(api.height)).rounded())
    return Point(x: max(0, min(api.width - 1, x)), y: max(0, min(api.height - 1, y)))
}

func mouseButton(_ raw: String?) -> CGMouseButton {
    switch raw ?? "left" {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

func mouseEventType(button: CGMouseButton, down: Bool) -> CGEventType {
    switch button {
    case .right: return down ? .rightMouseDown : .rightMouseUp
    case .center: return down ? .otherMouseDown : .otherMouseUp
    default: return down ? .leftMouseDown : .leftMouseUp
    }
}

func postMouseMove(_ p: CGPoint) {
    if let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) {
        event.post(tap: .cghidEventTap)
    }
}

func postClick(_ p: CGPoint, button: CGMouseButton, count: Int) {
    for i in 1...max(1, count) {
        if let down = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: true), mouseCursorPosition: p, mouseButton: button),
           let up = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: false), mouseCursorPosition: p, mouseButton: button) {
            down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            down.post(tap: .cghidEventTap)
            usleep(35_000)
            up.post(tap: .cghidEventTap)
            usleep(35_000)
        }
    }
}

func typeUnicode(_ text: String) {
    for scalar in text.utf16 {
        var chars = [UniChar(scalar)]
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(7_000)
    }
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47
]

func postKey(_ raw: String) {
    let parts = raw.lowercased().split(separator: "+").map(String.init)
    guard let keyPart = parts.last, let code = keyCodes[keyPart] else {
        typeUnicode(raw)
        return
    }
    var flags: CGEventFlags = []
    for part in parts.dropLast() {
        switch part {
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        case "meta", "cmd", "command", "super": flags.insert(.maskCommand)
        default: break
        }
    }
    if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
       let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        usleep(20_000)
        up.post(tap: .cghidEventTap)
    }
}

func screenshotBase64() -> String? {
    guard let image = CGWindowListCreateImage(.infinite, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else { return nil }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
    return data.base64EncodedString()
}

func visibleWindows() -> [WindowInfo] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var result: [WindowInfo] = []
    for item in list.prefix(40) {
        let owner = item[kCGWindowOwnerName as String] as? String ?? ""
        let title = item[kCGWindowName as String] as? String ?? ""
        let number = item[kCGWindowNumber as String] as? NSNumber
        let name = title.isEmpty ? owner : "\(owner) — \(title)"
        if name.isEmpty { continue }
        result.append(WindowInfo(id: number?.stringValue ?? "", name: name))
    }
    return result
}

func activeWindow() -> WindowInfo? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return WindowInfo(id: String(app.processIdentifier), name: app.localizedName ?? app.bundleIdentifier ?? "")
}

func perform(_ action: Action, display: Resolution, api: Resolution) {
    switch action.action {
    case "screenshot": return
    case "move":
        guard let x = action.x, let y = action.y else { fail("move requires x and y") }
        postMouseMove(scale(Point(x: x, y: y), display: display, api: api))
    case "click":
        let current = CGEvent(source: nil)?.location ?? .zero
        let target = (action.x != nil && action.y != nil) ? scale(Point(x: action.x!, y: action.y!), display: display, api: api) : current
        postMouseMove(target)
        postClick(target, button: mouseButton(action.button), count: action.count ?? 1)
    case "drag":
        let points: [Point]
        if let path = action.path, path.count >= 2 { points = path }
        else if let x = action.x, let y = action.y, let x2 = action.x2, let y2 = action.y2 { points = [Point(x:x,y:y), Point(x:x2,y:y2)] }
        else { fail("drag requires path or x/y/x2/y2") }
        let button = mouseButton(action.button)
        let scaled = points.map { scale($0, display: display, api: api) }
        postMouseMove(scaled[0])
        if let down = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: true), mouseCursorPosition: scaled[0], mouseButton: button) { down.post(tap: .cghidEventTap) }
        for p in scaled.dropFirst() {
            if let drag = CGEvent(mouseEventSource: nil, mouseType: button == .right ? .rightMouseDragged : (button == .center ? .otherMouseDragged : .leftMouseDragged), mouseCursorPosition: p, mouseButton: button) { drag.post(tap: .cghidEventTap) }
            usleep(12_000)
        }
        if let up = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: false), mouseCursorPosition: scaled.last!, mouseButton: button) { up.post(tap: .cghidEventTap) }
    case "type":
        typeUnicode(action.text ?? "")
    case "key":
        postKey(action.key ?? "")
    case "scroll":
        let amount = Int32(max(1, action.amount ?? 3))
        let direction = action.direction ?? "down"
        let dy: Int32 = direction == "up" ? amount : (direction == "down" ? -amount : 0)
        let dx: Int32 = direction == "left" ? amount : (direction == "right" ? -amount : 0)
        if let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) { event.post(tap: .cghidEventTap) }
    case "wait":
        usleep(useconds_t(max(0, action.durationMs ?? 1000) * 1000))
    default:
        fail("unsupported action \(action.action)")
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: input) else { fail("invalid JSON request") }
let apiWidth = max(320, request.apiWidth ?? 1280)
let resolutions = mainResolution(apiWidth: apiWidth)
let shouldPrompt = request.doctor ?? false
let permissions = Permissions(accessibility: accessibilityAllowed(prompt: shouldPrompt), screenRecording: screenRecordingAllowed(prompt: shouldPrompt))

if !(request.actions ?? []).isEmpty && !permissions.accessibility {
    fail("Accessibility permission is required. Enable this app/helper in System Settings > Privacy & Security > Accessibility.")
}
for action in request.actions ?? [] {
    perform(action, display: resolutions.display, api: resolutions.api)
}
if !(request.actions ?? []).isEmpty { usleep(180_000) }
let cursor = apiPoint(CGEvent(source: nil)?.location ?? .zero, display: resolutions.display, api: resolutions.api)
let capture = request.includeScreenshot ?? true
let screenshot = capture ? screenshotBase64() : nil
if capture && screenshot == nil { fail("Screen Recording permission is required to capture the desktop.") }
let response = Response(
    ok: true,
    error: nil,
    displayResolution: resolutions.display,
    apiResolution: resolutions.api,
    cursorPosition: cursor,
    activeWindow: activeWindow(),
    windows: (request.includeWindows ?? false) ? visibleWindows() : [],
    screenshotMimeType: screenshot == nil ? nil : "image/png",
    screenshotBase64: screenshot,
    permissions: permissions
)
let data = try! JSONEncoder().encode(response)
FileHandle.standardOutput.write(data)
