import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

struct Point: Codable { let x: Int; let y: Int }
struct RectInfo: Codable { let x: Int; let y: Int; let width: Int; let height: Int }
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
struct ElementOptions: Codable {
    let maxElements: Int?
    let includeStaticText: Bool?
    let role: String?
    let query: String?
    let name: String?
    let application: String?
    let includeContainers: Bool?
}
struct ElementActionRequest: Codable { let elementId: String; let action: String; let value: String? }
struct Request: Codable {
    let apiWidth: Int?
    let actions: [Action]?
    let includeScreenshot: Bool?
    let includeWindows: Bool?
    let doctor: Bool?
    let includeElements: Bool?
    let elementOptions: ElementOptions?
    let elementAction: ElementActionRequest?
    let listApplications: Bool?
    let targetApplication: String?
}
struct Permissions: Codable, Sendable { let accessibility: Bool; let screenRecording: Bool }
struct ApplicationInfo: Codable {
    let id: String
    let displayName: String
    let path: String
    let isRunning: Bool
    let pid: Int?
}
final class ApplicationLaunchResult: @unchecked Sendable { var error: Error? }
struct ElementInfo: Codable {
    let id: String
    let source: String
    let role: String
    let name: String
    let value: String
    let description: String
    let subrole: String
    let identifier: String
    let placeholder: String
    let url: String
    let depth: Int
    let enabled: Bool
    let focused: Bool
    let selected: Bool
    let checked: Bool?
    let expanded: Bool?
    let bounds: RectInfo?
    let actions: [String]
    let nativeActions: [String]
}
struct ElementActionResult: Codable { let ok: Bool; let source: String; let action: String }
struct Response: Codable {
    var ok: Bool
    var error: String? = nil
    var displayResolution: Resolution? = nil
    var apiResolution: Resolution? = nil
    var cursorPosition: Point? = nil
    var activeWindow: WindowInfo? = nil
    var windows: [WindowInfo]? = nil
    var screenshotMimeType: String? = nil
    var screenshotBase64: String? = nil
    var permissions: Permissions? = nil
    var elementSource: String? = nil
    var elementApplication: String? = nil
    var elementApplicationId: String? = nil
    var elements: [ElementInfo]? = nil
    var elementMessage: String? = nil
    var elementActionResult: ElementActionResult? = nil
    var applications: [ApplicationInfo]? = nil
}

let processArguments = CommandLine.arguments
func argumentValue(_ name: String) -> String? {
    guard let index = processArguments.firstIndex(of: name), index + 1 < processArguments.count else { return nil }
    return processArguments[index + 1]
}
let responseFile = argumentValue("--response-file")

func emit(_ response: Response) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try! encoder.encode(response)
    if let responseFile {
        do { try data.write(to: URL(fileURLWithPath: responseFile), options: .atomic) }
        catch { FileHandle.standardError.write(Data("could not write response: \(error)".utf8)); exit(1) }
    } else {
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}

func fail(_ message: String) -> Never { emit(Response(ok: false, error: message)) }

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

@MainActor
func permissionSnapshot(prompt: Bool) -> Permissions {
    if prompt {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.activate(ignoringOtherApps: true)
    }
    let accessibility = accessibilityAllowed(prompt: prompt)
    // Request one protected capability per doctor run. This prevents two
    // system dialogs from racing while the first permission is still pending.
    let screenRecording = accessibility
        ? screenRecordingAllowed(prompt: prompt)
        : screenRecordingAllowed(prompt: false)
    return Permissions(accessibility: accessibility, screenRecording: screenRecording)
}

func mainResolution(apiWidth: Int) -> (display: Resolution, api: Resolution) {
    let displayID = CGMainDisplayID()
    let w = Int(CGDisplayPixelsWide(displayID))
    let h = Int(CGDisplayPixelsHigh(displayID))
    let apiHeight = Int((Double(apiWidth) / (Double(w) / Double(h))).rounded())
    return (Resolution(width: w, height: h), Resolution(width: apiWidth, height: apiHeight))
}

func scale(_ point: Point, display: Resolution, api: Resolution) -> CGPoint {
    CGPoint(
        x: (Double(point.x) / Double(api.width) * Double(display.width)).rounded(),
        y: (Double(point.y) / Double(api.height) * Double(display.height)).rounded()
    )
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
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func postClick(_ p: CGPoint, button: CGMouseButton, count: Int) {
    for i in 1...max(1, count) {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: true), mouseCursorPosition: p, mouseButton: button),
              let up = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: false), mouseCursorPosition: p, mouseButton: button) else { continue }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down.post(tap: .cghidEventTap); usleep(35_000); up.post(tap: .cghidEventTap); usleep(35_000)
    }
}

func typeUnicode(_ text: String) {
    for scalar in text.utf16 {
        var chars = [UniChar(scalar)]
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap); usleep(7_000)
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
    guard let keyPart = parts.last, let code = keyCodes[keyPart] else { typeUnicode(raw); return }
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
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return }
    down.flags = flags; up.flags = flags
    down.post(tap: .cghidEventTap); usleep(20_000); up.post(tap: .cghidEventTap)
}

func screenshotWithSystemTool() -> String? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("chatgpt-computer-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: url) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-t", "png", url.path]
    do {
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return try Data(contentsOf: url).base64EncodedString()
    } catch {
        return nil
    }
}

func screenshotBase64() async -> String? {
    if #available(macOS 14.0, *) {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let mainID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
                return screenshotWithSystemTool()
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = display.width
            configuration.height = display.height
            configuration.showsCursor = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let rep = NSBitmapImageRep(cgImage: image)
            if let data = rep.representation(using: .png, properties: [:]) {
                return data.base64EncodedString()
            }
        } catch {
            // Fall back to the system capture utility for older/limited sessions.
        }
    }
    return screenshotWithSystemTool()
}

func visibleWindows() -> [WindowInfo] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.prefix(40).compactMap { item in
        let owner = item[kCGWindowOwnerName as String] as? String ?? ""
        let title = item[kCGWindowName as String] as? String ?? ""
        let number = item[kCGWindowNumber as String] as? NSNumber
        let name = title.isEmpty ? owner : "\(owner) — \(title)"
        return name.isEmpty ? nil : WindowInfo(id: number?.stringValue ?? "", name: name)
    }
}

func activeWindow() -> WindowInfo? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return WindowInfo(id: String(app.processIdentifier), name: app.localizedName ?? app.bundleIdentifier ?? "")
}

func installedApplications() -> [ApplicationInfo] {
    var byIdentifier: [String: ApplicationInfo] = [:]
    for app in NSWorkspace.shared.runningApplications {
        let identifier = app.bundleIdentifier ?? "pid:\(app.processIdentifier)"
        byIdentifier[identifier] = ApplicationInfo(
            id: identifier,
            displayName: app.localizedName ?? identifier,
            path: app.bundleURL?.path ?? "",
            isRunning: true,
            pid: Int(app.processIdentifier)
        )
    }

    let roots = ["/Applications", "/System/Applications", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
    for root in roots {
        guard let enumerator = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
        for case let url as URL in enumerator {
            guard url.pathExtension.lowercased() == "app", let bundle = Bundle(url: url) else { continue }
            let identifier = bundle.bundleIdentifier ?? url.deletingPathExtension().lastPathComponent
            if byIdentifier[identifier] == nil {
                let displayName = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? url.deletingPathExtension().lastPathComponent
                byIdentifier[identifier] = ApplicationInfo(id: identifier, displayName: displayName, path: url.path, isRunning: false, pid: nil)
            }
            enumerator.skipDescendants()
            if byIdentifier.count >= 300 { break }
        }
    }
    return byIdentifier.values.sorted {
        if $0.isRunning != $1.isRunning { return $0.isRunning && !$1.isRunning }
        return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
    }
}

func resolveRunningApplication(_ requested: String) -> NSRunningApplication? {
    let needle = requested.lowercased()
    let candidates = NSWorkspace.shared.runningApplications
    if let exact = candidates.first(where: { ($0.bundleIdentifier ?? "").lowercased() == needle }) { return exact }
    if let exact = candidates.first(where: { ($0.localizedName ?? "").lowercased() == needle }) { return exact }
    return candidates.first {
        "\($0.localizedName ?? "") \($0.bundleIdentifier ?? "")".lowercased().contains(needle)
    }
}

func activateApplication(_ requested: String) {
    if let running = resolveRunningApplication(requested) {
        running.activate(options: [])
        return
    }
    let known = installedApplications().first {
        $0.id.caseInsensitiveCompare(requested) == .orderedSame || $0.displayName.caseInsensitiveCompare(requested) == .orderedSame
    }
    let url: URL?
    if let known, !known.path.isEmpty { url = URL(fileURLWithPath: known.path) }
    else { url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: requested) }
    guard let url else { fail("Application not found: \(requested)") }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    let semaphore = DispatchSemaphore(value: 0)
    let result = ApplicationLaunchResult()
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
        result.error = error
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 10)
    if let launchError = result.error { fail("Unable to launch \(requested): \(launchError.localizedDescription)") }
    usleep(500_000)
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
        postMouseMove(target); postClick(target, button: mouseButton(action.button), count: action.count ?? 1)
    case "drag":
        let points: [Point]
        if let path = action.path, path.count >= 2 { points = path }
        else if let x = action.x, let y = action.y, let x2 = action.x2, let y2 = action.y2 { points = [Point(x: x, y: y), Point(x: x2, y: y2)] }
        else { fail("drag requires path or x/y/x2/y2") }
        let button = mouseButton(action.button)
        let scaled = points.map { scale($0, display: display, api: api) }
        postMouseMove(scaled[0])
        CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: true), mouseCursorPosition: scaled[0], mouseButton: button)?.post(tap: .cghidEventTap)
        for p in scaled.dropFirst() {
            let kind: CGEventType = button == .right ? .rightMouseDragged : (button == .center ? .otherMouseDragged : .leftMouseDragged)
            CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: p, mouseButton: button)?.post(tap: .cghidEventTap)
            usleep(12_000)
        }
        CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: false), mouseCursorPosition: scaled.last!, mouseButton: button)?.post(tap: .cghidEventTap)
    case "type": typeUnicode(action.text ?? "")
    case "key": postKey(action.key ?? "")
    case "scroll":
        let amount = Int32(max(1, action.amount ?? 3))
        let direction = action.direction ?? "down"
        let dy: Int32 = direction == "up" ? amount : (direction == "down" ? -amount : 0)
        let dx: Int32 = direction == "left" ? amount : (direction == "right" ? -amount : 0)
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
    case "wait": usleep(useconds_t(max(0, action.durationMs ?? 1000) * 1000))
    default: fail("unsupported action \(action.action)")
    }
}

// MARK: - AX semantic control

func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute, &value) == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String {
    guard let value = axAttribute(element, attribute) else { return "" }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return String(describing: value)
}

func axBool(_ element: AXUIElement, _ attribute: CFString, default fallback: Bool = false) -> Bool {
    guard let value = axAttribute(element, attribute) else { return fallback }
    if let boolean = value as? Bool { return boolean }
    if let number = value as? NSNumber { return number.boolValue }
    return fallback
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    (axAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func axSettable(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element, attribute, &settable) == .success && settable.boolValue
}

func axRect(_ element: AXUIElement) -> RectInfo? {
    guard let positionValue = axAttribute(element, kAXPositionAttribute as CFString),
          let sizeValue = axAttribute(element, kAXSizeAttribute as CFString),
          CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return RectInfo(x: Int(position.x.rounded()), y: Int(position.y.rounded()), width: max(0, Int(size.width.rounded())), height: max(0, Int(size.height.rounded())))
}

func axEncodeElementId(pid: pid_t, path: [Int]) -> String {
    let payload: [String: Any] = ["source": "macos-ax", "pid": Int(pid), "path": path]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    return data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func axDecodeElementId(_ value: String) -> (pid: pid_t, path: [Int])? {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64 += "=" }
    guard let data = Data(base64Encoded: base64),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          payload["source"] as? String == "macos-ax",
          let pid = payload["pid"] as? Int,
          let path = payload["path"] as? [Int] else { return nil }
    return (pid_t(pid), path)
}

func axResolve(pid: pid_t, path: [Int]) -> AXUIElement? {
    var element = AXUIElementCreateApplication(pid)
    for index in path {
        let children = axChildren(element)
        guard index >= 0 && index < children.count else { return nil }
        element = children[index]
    }
    return element
}

let axInteractiveRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXComboBox", "AXDisclosureTriangle", "AXLink", "AXMenuItem",
    "AXPopUpButton", "AXRadioButton", "AXSearchField", "AXSlider", "AXTab", "AXTextArea",
    "AXTextField", "AXToolbarButton"
]
let axStaticRoles: Set<String> = ["AXHeading", "AXImage", "AXStaticText"]

func semanticActions(_ element: AXUIElement, role: String, native: [String]) -> [String] {
    var result: [String] = []
    if native.contains(kAXPressAction as String) || axInteractiveRoles.contains(role) { result.append("press") }
    if axSettable(element, kAXFocusedAttribute as CFString) { result.append("focus") }
    if axSettable(element, kAXValueAttribute as CFString) { result.append("set_value") }
    if native.contains(kAXIncrementAction as String) { result.append("increment") }
    if native.contains(kAXDecrementAction as String) { result.append("decrement") }
    if role == "AXCheckBox" || role == "AXRadioButton" { result.append("toggle") }
    result.append("scroll_into_view")
    return Array(NSOrderedSet(array: result)) as? [String] ?? result
}

func axElementInfo(_ element: AXUIElement, pid: pid_t, path: [Int], depth: Int) -> ElementInfo {
    let role = axString(element, kAXRoleAttribute as CFString)
    let native = axActions(element)
    let rawValue = axString(element, kAXValueAttribute as CFString)
    let checked: Bool? = (role == "AXCheckBox" || role == "AXRadioButton") ? axBool(element, kAXValueAttribute as CFString) : nil
    let expanded: Bool? = axAttribute(element, kAXExpandedAttribute as CFString) == nil ? nil : axBool(element, kAXExpandedAttribute as CFString)
    return ElementInfo(
        id: axEncodeElementId(pid: pid, path: path), source: "macos-ax", role: role,
        name: axString(element, kAXTitleAttribute as CFString).isEmpty ? axString(element, kAXDescriptionAttribute as CFString) : axString(element, kAXTitleAttribute as CFString),
        value: String(rawValue.prefix(4000)), description: String(axString(element, kAXHelpAttribute as CFString).prefix(1000)),
        subrole: axString(element, kAXSubroleAttribute as CFString),
        identifier: axString(element, kAXIdentifierAttribute as CFString),
        placeholder: axString(element, kAXPlaceholderValueAttribute as CFString),
        url: String(axString(element, kAXURLAttribute as CFString).prefix(4000)), depth: depth,
        enabled: axBool(element, kAXEnabledAttribute as CFString, default: true),
        focused: axBool(element, kAXFocusedAttribute as CFString), selected: axBool(element, kAXSelectedAttribute as CFString),
        checked: checked, expanded: expanded, bounds: axRect(element), actions: semanticActions(element, role: role, native: native), nativeActions: native
    )
}

func listAXElements(options: ElementOptions?) -> (application: String, applicationId: String, elements: [ElementInfo]) {
    let requestedApplication = (options?.application ?? "").lowercased()
    let app: NSRunningApplication?
    if requestedApplication.isEmpty {
        app = NSWorkspace.shared.frontmostApplication
    } else {
        app = resolveRunningApplication(requestedApplication)
    }
    guard let app else { return ("", "", []) }
    let pid = app.processIdentifier
    let root = AXUIElementCreateApplication(pid)
    let maximum = max(1, min(options?.maxElements ?? 120, 500))
    let includeStatic = options?.includeStaticText ?? false
    let includeContainers = options?.includeContainers ?? false
    let roleFilter = (options?.role ?? "").lowercased()
    let query = (options?.query ?? options?.name ?? "").lowercased()
    var result: [ElementInfo] = []

    func walk(_ element: AXUIElement, path: [Int], depth: Int) {
        if depth > 20 || result.count >= maximum { return }
        let role = axString(element, kAXRoleAttribute as CFString)
        let hasIdentity = !axString(element, kAXTitleAttribute as CFString).isEmpty || !axString(element, kAXDescriptionAttribute as CFString).isEmpty || !axString(element, kAXIdentifierAttribute as CFString).isEmpty
        let interesting = axInteractiveRoles.contains(role) || axBool(element, kAXFocusedAttribute as CFString) || (includeStatic && axStaticRoles.contains(role)) || (includeContainers && hasIdentity)
        if depth > 0 && interesting {
            let info = axElementInfo(element, pid: pid, path: path, depth: depth)
            let searchable = "\(info.name) \(info.description) \(info.value) \(info.placeholder) \(info.url) \(info.identifier)".lowercased()
            if (roleFilter.isEmpty || info.role.lowercased() == roleFilter) && (query.isEmpty || searchable.contains(query)) { result.append(info) }
        }
        for (index, child) in axChildren(element).prefix(500).enumerated() {
            if result.count >= maximum { break }
            walk(child, path: path + [index], depth: depth + 1)
        }
    }
    walk(root, path: [], depth: 0)
    return (app.localizedName ?? app.bundleIdentifier ?? "", app.bundleIdentifier ?? "", result)
}

func performAXElementAction(_ request: ElementActionRequest) -> ElementActionResult {
    guard let decoded = axDecodeElementId(request.elementId), let element = axResolve(pid: decoded.pid, path: decoded.path) else { fail("The macOS accessibility snapshot is stale; refresh computer_elements.") }
    let action = request.action
    var error: AXError = .success
    switch action {
    case "press", "toggle": error = AXUIElementPerformAction(element, kAXPressAction as CFString)
    case "focus": error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    case "set_value": error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, (request.value ?? "") as CFTypeRef)
    case "increment": error = AXUIElementPerformAction(element, kAXIncrementAction as CFString)
    case "decrement": error = AXUIElementPerformAction(element, kAXDecrementAction as CFString)
    case "scroll_into_view":
        error = AXUIElementPerformAction(element, "AXScrollToVisible" as CFString)
        if error != .success { error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
    case let native where native.hasPrefix("native:"):
        let nativeAction = String(native.dropFirst("native:".count))
        guard axActions(element).contains(nativeAction) else { fail("Element does not expose native accessibility action \(nativeAction)") }
        error = AXUIElementPerformAction(element, nativeAction as CFString)
    default: fail("Unsupported macOS element action: \(action)")
    }
    if error != .success { fail("macOS accessibility action \(action) failed with AXError \(error.rawValue)") }
    return ElementActionResult(ok: true, source: "macos-ax", action: action)
}

func runHelper() async {
    let input: Data
    if let requestFile = argumentValue("--request-file") {
        do { input = try Data(contentsOf: URL(fileURLWithPath: requestFile)) }
        catch { fail("could not read request: \(error)") }
    } else {
        input = FileHandle.standardInput.readDataToEndOfFile()
    }
    guard let request = try? JSONDecoder().decode(Request.self, from: input) else { fail("invalid JSON request") }
    let apiWidth = max(320, request.apiWidth ?? 1280)
    let resolutions = mainResolution(apiWidth: apiWidth)
    let shouldPrompt = request.doctor ?? false
    var permissions = await permissionSnapshot(prompt: shouldPrompt)
    if shouldPrompt && permissions.accessibility && !permissions.screenRecording {
        // CGRequestScreenCaptureAccess schedules system UI asynchronously.
        // Keep the named app alive while the user opens System Settings and
        // toggles the permission, otherwise macOS can discard the pending UI.
        for _ in 0..<120 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            let granted = await MainActor.run { screenRecordingAllowed(prompt: false) }
            if granted {
                permissions = Permissions(accessibility: true, screenRecording: true)
                break
            }
        }
    }

    if let target = request.targetApplication, !target.isEmpty { activateApplication(target) }

    if (!(request.actions ?? []).isEmpty || request.includeElements == true || request.elementAction != nil) && !permissions.accessibility {
        fail("Accessibility permission is required. Enable this helper in System Settings > Privacy & Security > Accessibility.")
    }
    var elementActionResult: ElementActionResult? = nil
    if let elementAction = request.elementAction { elementActionResult = performAXElementAction(elementAction) }
    for action in request.actions ?? [] { perform(action, display: resolutions.display, api: resolutions.api) }
    if !(request.actions ?? []).isEmpty || request.elementAction != nil { usleep(180_000) }

    var elementApplication: String? = nil
    var elementApplicationId: String? = nil
    var elements: [ElementInfo]? = nil
    if request.includeElements == true {
        let listed = listAXElements(options: request.elementOptions)
        elementApplication = listed.application
        elementApplicationId = listed.applicationId
        elements = listed.elements
    }

    let cursor = apiPoint(CGEvent(source: nil)?.location ?? .zero, display: resolutions.display, api: resolutions.api)
    let capture = request.includeScreenshot ?? true
    let screenshot = capture ? await screenshotBase64() : nil
    if capture && screenshot == nil { fail("Screen Recording permission is required to capture the desktop.") }
    emit(Response(
        ok: true,
        displayResolution: resolutions.display,
        apiResolution: resolutions.api,
        cursorPosition: cursor,
        activeWindow: activeWindow(),
        windows: (request.includeWindows ?? false) ? visibleWindows() : [],
        screenshotMimeType: screenshot == nil ? nil : "image/png",
        screenshotBase64: screenshot,
        permissions: permissions,
        elementSource: request.includeElements == true ? "macos-ax" : nil,
        elementApplication: elementApplication,
        elementApplicationId: elementApplicationId,
        elements: elements,
        elementMessage: elements == nil ? nil : "Returned \(elements!.count) macOS accessibility elements.",
        elementActionResult: elementActionResult,
        applications: request.listApplications == true ? installedApplications() : nil
    ))
}

Task { await runHelper() }
RunLoop.main.run()
