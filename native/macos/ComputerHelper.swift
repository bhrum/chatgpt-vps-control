import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

@objc protocol ComputerRequestXPCProtocol {
    func perform(request: Data, withReply reply: @escaping (Data?, String?) -> Void)
}

func runIsolatedNativeRequest(_ input: Data, executableURL: URL) throws -> Data {
    let maximumResponseBytes = 24 * 1024 * 1024
    let child = Process()
    child.executableURL = executableURL
    child.arguments = ["--one-shot"]
    let childInput = Pipe()
    let childOutput = Pipe()
    let childError = Pipe()
    child.standardInput = childInput
    child.standardOutput = childOutput
    child.standardError = childError
    try child.run()
    childInput.fileHandleForWriting.write(input)
    try? childInput.fileHandleForWriting.close()
    let output = childOutput.fileHandleForReading.readDataToEndOfFile()
    let errorData = childError.fileHandleForReading.readDataToEndOfFile()
    child.waitUntilExit()
    guard child.terminationStatus == 0 else {
        let detail = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        throw NSError(domain: "NativeRequest", code: Int(child.terminationStatus), userInfo: [NSLocalizedDescriptionKey: detail.isEmpty ? "Native helper child exited with \(child.terminationStatus)" : detail])
    }
    guard output.count <= maximumResponseBytes else {
        throw NSError(domain: "NativeRequest", code: 2, userInfo: [NSLocalizedDescriptionKey: "Native helper child response exceeded its size limit"])
    }
    return output
}

func performIsolatedRequest(_ request: Data, executableURL: URL) async throws -> Data {
    guard request.count <= 1 * 1024 * 1024,
          var requestObject = try JSONSerialization.jsonObject(with: request) as? [String: Any] else {
        throw NSError(domain: "ComputerRequest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native request exceeds its size limit or is invalid"])
    }
    let captureRequested = requestObject["includeScreenshot"] as? Bool ?? true
    if captureRequested { requestObject["includeScreenshot"] = false }
    let isolatedRequest = try JSONSerialization.data(withJSONObject: requestObject)
    let isolatedResponse = try runIsolatedNativeRequest(isolatedRequest, executableURL: executableURL)
    guard captureRequested else { return isolatedResponse }
    guard var responseObject = try JSONSerialization.jsonObject(with: isolatedResponse) as? [String: Any] else {
        throw NSError(domain: "ComputerRequest", code: 2, userInfo: [NSLocalizedDescriptionKey: "Native helper returned an invalid response"])
    }
    let bounds: RectInfo? = {
        guard let value = responseObject["screenshotBounds"] as? [String: Any],
              let x = value["x"] as? NSNumber, let y = value["y"] as? NSNumber,
              let width = value["width"] as? NSNumber, let height = value["height"] as? NSNumber else { return nil }
        return RectInfo(x: x.intValue, y: y.intValue, width: width.intValue, height: height.intValue)
    }()
    let pid = (responseObject["screenshotApplicationPid"] as? NSNumber).map { pid_t($0.int32Value) }
    guard let screenshot = await screenshotBase64(bounds: bounds, applicationPid: pid) else {
        throw NSError(domain: "ComputerRequest", code: 3, userInfo: [NSLocalizedDescriptionKey: "Screen Recording permission is required to capture the target window"])
    }
    responseObject["screenshotMimeType"] = "image/png"
    responseObject["screenshotBase64"] = screenshot
    responseObject["screenshotScope"] = bounds == nil ? "desktop" : "application"
    return try JSONSerialization.data(withJSONObject: responseObject)
}

final class ComputerRequestXPCService: NSObject, ComputerRequestXPCProtocol {
    func perform(request: Data, withReply reply: @escaping (Data?, String?) -> Void) {
        Task {
            do {
                let appContents = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
                let helper = appContents.appendingPathComponent("MacOS/ChatGPTComputerControl")
                reply(try await performIsolatedRequest(request, executableURL: helper), nil)
            } catch { reply(nil, error.localizedDescription) }
        }
    }
}

final class ComputerRequestXPCDelegate: NSObject, NSXPCListenerDelegate {
    private let service = ComputerRequestXPCService()
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.exportedInterface = NSXPCInterface(with: ComputerRequestXPCProtocol.self)
        connection.exportedObject = service
        connection.resume()
        return true
    }
}

func runComputerRequestXPCService() -> Never {
    let delegate = ComputerRequestXPCDelegate()
    let listener = NSXPCListener.service()
    listener.delegate = delegate
    listener.setConnectionCodeSigningRequirement("identifier \"com.bhrum.computer-control\"")
    listener.resume()
    RunLoop.current.run()
    exit(0)
}

var sharedRequestXPCConnection: NSXPCConnection? = nil

func requestXPCConnection() -> NSXPCConnection {
    if let connection = sharedRequestXPCConnection { return connection }
    let connection = NSXPCConnection(serviceName: "com.bhrum.computer-control.request-service")
    connection.remoteObjectInterface = NSXPCInterface(with: ComputerRequestXPCProtocol.self)
    connection.setCodeSigningRequirement("identifier \"com.bhrum.computer-control.request-service\"")
    connection.resume()
    sharedRequestXPCConnection = connection
    return connection
}

func discardRequestXPCConnection() {
    sharedRequestXPCConnection?.invalidate()
    sharedRequestXPCConnection = nil
}

func requestThroughXPC(_ input: Data) throws -> Data {
    let connection = requestXPCConnection()
    let semaphore = DispatchSemaphore(value: 0)
    var response: Data?
    var failure: String?
    guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
        failure = error.localizedDescription
        semaphore.signal()
    }) as? ComputerRequestXPCProtocol else {
        discardRequestXPCConnection()
        throw NSError(domain: "ComputerRequestXPC", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not create XPC service proxy"])
    }
    proxy.perform(request: input) { data, error in
        response = data
        failure = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 65) == .success else {
        discardRequestXPCConnection()
        throw NSError(domain: "ComputerRequestXPC", code: 3, userInfo: [NSLocalizedDescriptionKey: "XPC native request timed out"])
    }
    if let failure {
        discardRequestXPCConnection()
        throw NSError(domain: "ComputerRequestXPC", code: 4, userInfo: [NSLocalizedDescriptionKey: failure])
    }
    guard let response else { throw NSError(domain: "ComputerRequestXPC", code: 5, userInfo: [NSLocalizedDescriptionKey: "XPC service returned no response"]) }
    return response
}

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
    let maxDepth: Int?
    let maxVisitedNodes: Int?
    let focusedWindowOnly: Bool?
    let includeStaticText: Bool?
    let role: String?
    let query: String?
    let name: String?
    let application: String?
    let includeContainers: Bool?
}
struct ElementActionRequest: Codable {
    let elementId: String
    let action: String
    let value: String?
    let text: String?
    let prefix: String?
    let suffix: String?
    let selectionType: String?
    let button: String?
    let count: Int?
    let direction: String?
    let pages: Int?
    let eventObserverActive: Bool?
}
struct WindowActionRequest: Codable {
    let windowId: String
    let expectedName: String?
    let action: String
    let x: Int?
    let y: Int?
    let width: Int?
    let height: Int?
}
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
    let activateTargetApplication: Bool?
    let windowAction: WindowActionRequest?
}
struct Permissions: Codable, Sendable {
    let accessibility: Bool
    let screenRecording: Bool
    let interactiveDesktop: Bool
    let screenLocked: Bool
}
struct ApplicationInfo: Codable {
    let id: String
    let displayName: String
    let path: String
    let isRunning: Bool
    let pid: Int?
    let lastUsedDate: String?
    let useCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, displayName, path, isRunning, pid, lastUsedDate, useCount
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(displayName, forKey: .displayName)
        try container.encode(path, forKey: .path)
        try container.encode(isRunning, forKey: .isRunning)
        if let pid { try container.encode(pid, forKey: .pid) } else { try container.encodeNil(forKey: .pid) }
        if let lastUsedDate { try container.encode(lastUsedDate, forKey: .lastUsedDate) } else { try container.encodeNil(forKey: .lastUsedDate) }
        if let useCount { try container.encode(useCount, forKey: .useCount) } else { try container.encodeNil(forKey: .useCount) }
    }
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
struct ElementActionResult: Codable {
    let ok: Bool
    let source: String
    let action: String
    let settleDurationMs: Int
    let settleEventCount: Int
    let settleSource: String
}
struct WindowActionResult: Codable {
    let ok: Bool
    let source: String
    let action: String
    let windowId: String
    let settleDurationMs: Int
    let settleEventCount: Int
    let settleSource: String
}
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
    var screenshotScope: String? = nil
    var screenshotBounds: RectInfo? = nil
    var screenshotApplicationPid: Int? = nil
    var permissions: Permissions? = nil
    var elementSource: String? = nil
    var elementApplication: String? = nil
    var elementApplicationId: String? = nil
    var elements: [ElementInfo]? = nil
    var elementMessage: String? = nil
    var elementActionResult: ElementActionResult? = nil
    var applications: [ApplicationInfo]? = nil
    var windowActionResult: WindowActionResult? = nil
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

func sessionGuard() -> (interactive: Bool, locked: Bool) {
    guard let values = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return (false, true)
    }
    let onConsole = values[kCGSessionOnConsoleKey as String] as? Bool ?? false
    let loginDone = values[kCGSessionLoginDoneKey as String] as? Bool ?? false
    // Apple does not publish a separate typed constant for this value, but it
    // is part of the dictionary returned by CGSessionCopyCurrentDictionary.
    let locked = values["CGSSessionScreenIsLocked"] as? Bool ?? false
    return (onConsole && loginDone && !locked, locked)
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
    let session = sessionGuard()
    return Permissions(
        accessibility: accessibility,
        screenRecording: screenRecording,
        interactiveDesktop: session.interactive,
        screenLocked: session.locked
    )
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

func postEvent(_ event: CGEvent?, targetPid: pid_t? = nil) {
    guard let event else { return }
    if let targetPid { event.postToPid(targetPid) }
    else { event.post(tap: .cghidEventTap) }
}

func postMouseMove(_ p: CGPoint, targetPid: pid_t? = nil) {
    postEvent(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left), targetPid: targetPid)
}

func postClick(_ p: CGPoint, button: CGMouseButton, count: Int, targetPid: pid_t? = nil) {
    for i in 1...max(1, count) {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: true), mouseCursorPosition: p, mouseButton: button),
              let up = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: false), mouseCursorPosition: p, mouseButton: button) else { continue }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        postEvent(down, targetPid: targetPid); usleep(35_000); postEvent(up, targetPid: targetPid); usleep(35_000)
    }
}

func typeUnicode(_ text: String, targetPid: pid_t? = nil) {
    for scalar in text.utf16 {
        var chars = [UniChar(scalar)]
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        postEvent(down, targetPid: targetPid); postEvent(up, targetPid: targetPid); usleep(7_000)
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

func postKey(_ raw: String, targetPid: pid_t? = nil) {
    let parts = raw.lowercased().split(separator: "+").map(String.init)
    guard let keyPart = parts.last, let code = keyCodes[keyPart] else { typeUnicode(raw, targetPid: targetPid); return }
    var flags: CGEventFlags = []
    for part in parts.dropLast() {
        switch part {
        case "ctrl", "control", "ctrl_l", "ctrl_r", "control_l", "control_r": flags.insert(.maskControl)
        case "alt", "option", "alt_l", "alt_r", "option_l", "option_r": flags.insert(.maskAlternate)
        case "shift", "shift_l", "shift_r": flags.insert(.maskShift)
        case "meta", "cmd", "command", "super", "meta_l", "meta_r", "super_l", "super_r": flags.insert(.maskCommand)
        default: break
        }
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return }
    down.flags = flags; up.flags = flags
    postEvent(down, targetPid: targetPid); usleep(20_000); postEvent(up, targetPid: targetPid)
}

func screenshotWithSystemTool(bounds: RectInfo? = nil) -> String? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("chatgpt-computer-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: url) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    var arguments = ["-x", "-t", "png"]
    if let bounds { arguments += ["-R", "\(bounds.x),\(bounds.y),\(bounds.width),\(bounds.height)"] }
    arguments.append(url.path)
    process.arguments = arguments
    do {
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return try Data(contentsOf: url).base64EncodedString()
    } catch {
        return nil
    }
}

var cachedShareableContent: SCShareableContent? = nil
var cachedShareableContentAt: TimeInterval = 0

@available(macOS 14.0, *)
func shareableContent(refresh: Bool = false) async throws -> SCShareableContent {
    let now = ProcessInfo.processInfo.systemUptime
    if !refresh, let cachedShareableContent, now - cachedShareableContentAt < 60 { return cachedShareableContent }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    cachedShareableContent = content
    cachedShareableContentAt = now
    return content
}

func screenshotBase64(bounds: RectInfo? = nil, applicationPid: pid_t? = nil) async -> String? {
    if #available(macOS 14.0, *) {
        do {
            var content = try await shareableContent()
            if let applicationPid, let bounds {
                let requested = CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
                var candidates = content.windows.filter { $0.owningApplication?.processID == applicationPid }
                if candidates.isEmpty {
                    content = try await shareableContent(refresh: true)
                    candidates = content.windows.filter { $0.owningApplication?.processID == applicationPid }
                }
                let window = candidates.min {
                    let left = abs($0.frame.midX - requested.midX) + abs($0.frame.midY - requested.midY) + abs($0.frame.width - requested.width) + abs($0.frame.height - requested.height)
                    let right = abs($1.frame.midX - requested.midX) + abs($1.frame.midY - requested.midY) + abs($1.frame.width - requested.width) + abs($1.frame.height - requested.height)
                    return left < right
                }
                if let window {
                    let filter = SCContentFilter(desktopIndependentWindow: window)
                    let configuration = SCStreamConfiguration()
                    configuration.width = max(1, Int(window.frame.width.rounded()))
                    configuration.height = max(1, Int(window.frame.height.rounded()))
                    configuration.showsCursor = false
                    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                    let rep = NSBitmapImageRep(cgImage: image)
                    if let data = rep.representation(using: .png, properties: [:]) { return data.base64EncodedString() }
                }
            }
            let mainID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
                return screenshotWithSystemTool(bounds: bounds)
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let configuration = SCStreamConfiguration()
            if let bounds {
                let localX = CGFloat(bounds.x) - display.frame.origin.x
                let localY = CGFloat(bounds.y) - display.frame.origin.y
                let requested = CGRect(x: localX, y: localY, width: CGFloat(bounds.width), height: CGFloat(bounds.height))
                let displayRect = CGRect(x: 0, y: 0, width: display.frame.width, height: display.frame.height)
                let clipped = requested.intersection(displayRect)
                guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { return screenshotWithSystemTool(bounds: bounds) }
                configuration.sourceRect = clipped
                configuration.width = max(1, Int(clipped.width.rounded()))
                configuration.height = max(1, Int(clipped.height.rounded()))
            } else {
                configuration.width = display.width
                configuration.height = display.height
            }
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
    return screenshotWithSystemTool(bounds: bounds)
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

func resolveAXWindow(windowId: String, expectedName: String?) -> (pid: pid_t, window: AXUIElement)? {
    guard let numericId = UInt32(windowId),
          let descriptions = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(numericId)) as? [[String: Any]],
          let item = descriptions.first,
          let ownerPid = item[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
    let owner = item[kCGWindowOwnerName as String] as? String ?? ""
    let title = item[kCGWindowName as String] as? String ?? ""
    let currentName = title.isEmpty ? owner : "\(owner) — \(title)"
    if let expectedName, !expectedName.isEmpty, currentName != expectedName { return nil }
    let pid = pid_t(ownerPid.int32Value)
    let application = AXUIElementCreateApplication(pid)
    guard let windows = axAttribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] else { return nil }
    for window in windows {
        let number = axAttribute(window, "AXWindowNumber" as CFString) as? NSNumber
        if number?.uint32Value == numericId { return (pid, window) }
    }
    return nil
}

func performAXWindowAction(_ request: WindowActionRequest, display: Resolution, api: Resolution) -> WindowActionResult {
    guard let resolved = resolveAXWindow(windowId: request.windowId, expectedName: request.expectedName) else { fail("The macOS window is stale, unavailable, or changed identity; refresh computer_state.") }
    let observation = beginAXSettleObservation(pid: resolved.pid)
    let app = NSRunningApplication(processIdentifier: resolved.pid)
    let window = resolved.window
    var error: AXError = .success
    switch request.action {
    case "activate":
        app?.activate(options: [])
        error = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    case "close":
        guard let closeButtonValue = axAttribute(window, kAXCloseButtonAttribute as CFString), CFGetTypeID(closeButtonValue) == AXUIElementGetTypeID() else { fail("The macOS window does not expose a close button.") }
        let closeButton = closeButtonValue as! AXUIElement
        error = AXUIElementPerformAction(closeButton, kAXPressAction as CFString)
    case "minimize":
        error = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    case "restore":
        if axSettable(window, "AXFullScreen" as CFString) {
            error = AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, kCFBooleanFalse)
        }
        if error != .success { break }
        error = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        if error == .success { app?.activate(options: []); error = AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
    case "maximize":
        if axSettable(window, "AXFullScreen" as CFString) {
            error = AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, kCFBooleanTrue)
        } else {
            guard let zoomButtonValue = axAttribute(window, kAXZoomButtonAttribute as CFString), CFGetTypeID(zoomButtonValue) == AXUIElementGetTypeID() else { fail("The macOS window does not expose maximize/full-screen control.") }
            let zoomButton = zoomButtonValue as! AXUIElement
            error = AXUIElementPerformAction(zoomButton, kAXPressAction as CFString)
        }
    case "move_resize":
        guard let x = request.x, let y = request.y, let width = request.width, let height = request.height,
              width > 0, height > 0 else { fail("move_resize requires positive x, y, width, and height.") }
        var position = CGPoint(x: CGFloat(x) * CGFloat(display.width) / CGFloat(api.width), y: CGFloat(y) * CGFloat(display.height) / CGFloat(api.height))
        var size = CGSize(width: CGFloat(width) * CGFloat(display.width) / CGFloat(api.width), height: CGFloat(height) * CGFloat(display.height) / CGFloat(api.height))
        guard let positionValue = AXValueCreate(.cgPoint, &position), let sizeValue = AXValueCreate(.cgSize, &size) else { fail("Could not encode the macOS window geometry.") }
        if axSettable(window, "AXFullScreen" as CFString) { _ = AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, kCFBooleanFalse) }
        error = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, positionValue)
        if error == .success { error = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue) }
    default: fail("Unsupported macOS window action: \(request.action)")
    }
    if error != .success { fail("macOS window action \(request.action) failed with AXError \(error.rawValue)") }
    let settle = finishAXSettleObservation(observation)
    return WindowActionResult(ok: true, source: "macos-ax-window", action: request.action, windowId: request.windowId, settleDurationMs: settle.durationMs, settleEventCount: settle.eventCount, settleSource: settle.source)
}

func installedApplications() -> [ApplicationInfo] {
    func usage(_ url: URL?) -> (String?, Int?) {
        guard let url, let item = NSMetadataItem(url: url) else { return (nil, nil) }
        let date = item.value(forAttribute: "kMDItemLastUsedDate") as? Date
        let count = (item.value(forAttribute: "kMDItemUseCount") as? NSNumber)?.intValue
        return (date.map { ISO8601DateFormatter().string(from: $0) }, count)
    }
    var byIdentifier: [String: ApplicationInfo] = [:]
    for app in NSWorkspace.shared.runningApplications {
        let identifier = app.bundleIdentifier ?? "pid:\(app.processIdentifier)"
        let metadata = usage(app.bundleURL)
        byIdentifier[identifier] = ApplicationInfo(
            id: identifier,
            displayName: app.localizedName ?? identifier,
            path: app.bundleURL?.path ?? "",
            isRunning: true,
            pid: Int(app.processIdentifier),
            lastUsedDate: metadata.0,
            useCount: metadata.1
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
                let metadata = usage(url)
                byIdentifier[identifier] = ApplicationInfo(id: identifier, displayName: displayName, path: url.path, isRunning: false, pid: nil, lastUsedDate: metadata.0, useCount: metadata.1)
            }
            enumerator.skipDescendants()
            if byIdentifier.count >= 300 { break }
        }
    }
    return byIdentifier.values.sorted {
        if $0.isRunning != $1.isRunning { return $0.isRunning && !$1.isRunning }
        if ($0.useCount ?? -1) != ($1.useCount ?? -1) { return ($0.useCount ?? -1) > ($1.useCount ?? -1) }
        if ($0.lastUsedDate ?? "") != ($1.lastUsedDate ?? "") { return ($0.lastUsedDate ?? "") > ($1.lastUsedDate ?? "") }
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

func applicationWindowTarget(_ requested: String) -> (pid: pid_t, bounds: RectInfo)? {
    guard let app = resolveRunningApplication(requested) else { return nil }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    axEnableApplicationTree(root)
    if let focused = axAttribute(root, kAXFocusedWindowAttribute as CFString), CFGetTypeID(focused) == AXUIElementGetTypeID(),
       let bounds = axRect(unsafeBitCast(focused, to: AXUIElement.self)), bounds.width > 0, bounds.height > 0 {
        return (app.processIdentifier, bounds)
    }
    if let window = axChildren(root).first(where: { axString($0, kAXRoleAttribute as CFString) == "AXWindow" }),
       let bounds = axRect(window), bounds.width > 0, bounds.height > 0 {
        return (app.processIdentifier, bounds)
    }
    return nil
}

func ensureApplication(_ requested: String, activate: Bool) {
    if let running = resolveRunningApplication(requested) {
        if activate { running.activate(options: []) }
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
    configuration.activates = activate
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

func perform(_ action: Action, display: Resolution, api: Resolution, origin: CGPoint = .zero, targetPid: pid_t? = nil) {
    func actionPoint(_ point: Point) -> CGPoint {
        let local = scale(point, display: display, api: api)
        return CGPoint(x: local.x + origin.x, y: local.y + origin.y)
    }
    switch action.action {
    case "screenshot": return
    case "move":
        guard let x = action.x, let y = action.y else { fail("move requires x and y") }
        postMouseMove(actionPoint(Point(x: x, y: y)), targetPid: targetPid)
    case "click":
        let current = CGEvent(source: nil)?.location ?? .zero
        let target = (action.x != nil && action.y != nil) ? actionPoint(Point(x: action.x!, y: action.y!)) : current
        postMouseMove(target, targetPid: targetPid); postClick(target, button: mouseButton(action.button), count: action.count ?? 1, targetPid: targetPid)
    case "drag":
        let points: [Point]
        if let path = action.path, path.count >= 2 { points = path }
        else if let x = action.x, let y = action.y, let x2 = action.x2, let y2 = action.y2 { points = [Point(x: x, y: y), Point(x: x2, y: y2)] }
        else { fail("drag requires path or x/y/x2/y2") }
        let button = mouseButton(action.button)
        let scaled = points.map(actionPoint)
        postMouseMove(scaled[0], targetPid: targetPid)
        postEvent(CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: true), mouseCursorPosition: scaled[0], mouseButton: button), targetPid: targetPid)
        for p in scaled.dropFirst() {
            let kind: CGEventType = button == .right ? .rightMouseDragged : (button == .center ? .otherMouseDragged : .leftMouseDragged)
            postEvent(CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: p, mouseButton: button), targetPid: targetPid)
            usleep(12_000)
        }
        postEvent(CGEvent(mouseEventSource: nil, mouseType: mouseEventType(button: button, down: false), mouseCursorPosition: scaled.last!, mouseButton: button), targetPid: targetPid)
    case "type": typeUnicode(action.text ?? "", targetPid: targetPid)
    case "key": postKey(action.key ?? "", targetPid: targetPid)
    case "scroll":
        let amount = Int32(max(1, action.amount ?? 3))
        let direction = action.direction ?? "down"
        let dy: Int32 = direction == "up" ? amount : (direction == "down" ? -amount : 0)
        let dx: Int32 = direction == "left" ? amount : (direction == "right" ? -amount : 0)
        postEvent(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0), targetPid: targetPid)
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

// Chromium, Electron, WKWebView, and some other embedded web runtimes keep
// their rich accessibility subtree lazy until an assistive client explicitly
// enables it. These attributes are intentionally best-effort: ordinary
// AppKit applications commonly reject one or both, while web-backed apps use
// them to expose the same controls that VoiceOver and Computer Use can see.
func axEnableApplicationTree(_ application: AXUIElement) {
    for attribute in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        _ = AXUIElementSetAttributeValue(application, attribute as CFString, kCFBooleanTrue)
    }
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    // AXChildren remains authoritative for path resolution. Web areas and
    // virtualized controls can expose additional descendants through one of
    // the other standard AX collections, so merge them deterministically and
    // remove native-object duplicates.
    let attributes = [
        "AXChildren",
        "AXChildrenInNavigationOrder",
        "AXVisibleChildren",
        "AXContents",
    ]
    var result: [AXUIElement] = []
    for attribute in attributes {
        guard let children = axAttribute(element, attribute as CFString) as? [AXUIElement] else { continue }
        for child in children where !result.contains(where: { CFEqual($0, child) }) {
            result.append(child)
        }
    }
    return result
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
    axEnableApplicationTree(element)
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
let axContainerRoles: Set<String> = [
    "AXApplication", "AXWindow", "AXGroup", "AXWebArea", "AXScrollArea", "AXToolbar",
    "AXMenuBar", "AXMenu", "AXList", "AXTable", "AXOutline", "AXRow"
]

func semanticActions(_ element: AXUIElement, role: String, native: [String]) -> [String] {
    var result: [String] = []
    if native.contains(kAXPressAction as String) || axInteractiveRoles.contains(role) { result.append(contentsOf: ["press", "click"]) }
    if let bounds = axRect(element), bounds.width > 0, bounds.height > 0 { result.append("click") }
    if axSettable(element, kAXFocusedAttribute as CFString) { result.append("focus") }
    if axSettable(element, kAXValueAttribute as CFString) { result.append("set_value") }
    if axSettable(element, kAXSelectedTextRangeAttribute as CFString) || role == "AXTextArea" || role == "AXTextField" || role == "AXSearchField" { result.append("select_text") }
    if native.contains(kAXIncrementAction as String) { result.append("increment") }
    if native.contains(kAXDecrementAction as String) { result.append("decrement") }
    if role == "AXCheckBox" || role == "AXRadioButton" { result.append("toggle") }
    result.append(contentsOf: ["scroll_into_view", "scroll"])
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

func listAXElements(options: ElementOptions?) -> (application: String, applicationId: String, elements: [ElementInfo], screenshotBounds: RectInfo?, applicationPid: pid_t?) {
    let requestedApplication = (options?.application ?? "").lowercased()
    let app: NSRunningApplication?
    if requestedApplication.isEmpty {
        app = NSWorkspace.shared.frontmostApplication
    } else {
        app = resolveRunningApplication(requestedApplication)
    }
    guard let app else { return ("", "", [], nil, nil) }
    let pid = app.processIdentifier
    let root = AXUIElementCreateApplication(pid)
    axEnableApplicationTree(root)
    var screenshotBounds: RectInfo? = nil
    var focusedWindow: AXUIElement? = nil
    if let focusedValue = axAttribute(root, kAXFocusedWindowAttribute as CFString), CFGetTypeID(focusedValue) == AXUIElementGetTypeID() {
        focusedWindow = unsafeBitCast(focusedValue, to: AXUIElement.self)
        screenshotBounds = focusedWindow.flatMap(axRect)
    }
    if screenshotBounds == nil {
        screenshotBounds = axChildren(root).first(where: { axString($0, kAXRoleAttribute as CFString) == "AXWindow" }).flatMap(axRect)
    }
    let maximum = max(1, min(options?.maxElements ?? 120, 500))
    let maximumDepth = max(1, min(options?.maxDepth ?? 16, 40))
    let maximumVisited = max(maximum, min(options?.maxVisitedNodes ?? max(1_500, maximum * 12), 20_000))
    let includeStatic = options?.includeStaticText ?? false
    let includeContainers = options?.includeContainers ?? false
    let roleFilter = (options?.role ?? "").lowercased()
    let query = (options?.query ?? options?.name ?? "").lowercased()
    var result: [ElementInfo] = []
    var visited = 0

    func walk(_ element: AXUIElement, path: [Int], depth: Int) {
        if depth > maximumDepth || result.count >= maximum || visited >= maximumVisited { return }
        visited += 1
        let role = axString(element, kAXRoleAttribute as CFString)
        let title = axString(element, kAXTitleAttribute as CFString)
        let elementDescription = axString(element, kAXDescriptionAttribute as CFString)
        let identifier = axString(element, kAXIdentifierAttribute as CFString)
        let hasIdentity = !title.isEmpty || !elementDescription.isEmpty || !identifier.isEmpty
        let interesting = axInteractiveRoles.contains(role)
            || axBool(element, kAXFocusedAttribute as CFString)
            || (includeStatic && axStaticRoles.contains(role))
            || (includeContainers && (hasIdentity || axContainerRoles.contains(role)))
        if depth > 0 && interesting {
            let roleMatches = roleFilter.isEmpty || role.lowercased() == roleFilter
            var queryMatches = query.isEmpty
            if roleMatches && !queryMatches {
                let quickSearchable = "\(title) \(elementDescription) \(identifier) \(axString(element, kAXValueAttribute as CFString)) \(axString(element, kAXPlaceholderValueAttribute as CFString)) \(axString(element, kAXURLAttribute as CFString))".lowercased()
                queryMatches = quickSearchable.contains(query)
            }
            if roleMatches && queryMatches { result.append(axElementInfo(element, pid: pid, path: path, depth: depth)) }
        }
        // Match the compact Computer Use tree: retain the menu bar and its
        // application-level headings, but do not recursively enumerate every
        // item from closed menus. The first macOS menu-bar child is the system
        // Apple menu, not part of the target application's own menu contract.
        if role == "AXMenuBarItem" { return }
        for (index, child) in axChildren(element).prefix(500).enumerated() {
            if result.count >= maximum || visited >= maximumVisited { break }
            if role == "AXMenuBar" && index == 0 && axString(child, kAXRoleAttribute as CFString) == "AXMenuBarItem" { continue }
            walk(child, path: path + [index], depth: depth + 1)
        }
    }
    let rootChildren = axChildren(root)
    if options?.focusedWindowOnly ?? false, let focusedWindow,
       let focusedIndex = rootChildren.firstIndex(where: { CFEqual($0, focusedWindow) }) {
        walk(focusedWindow, path: [focusedIndex], depth: 1)
    } else {
        walk(root, path: [], depth: 0)
    }
    return (app.localizedName ?? app.bundleIdentifier ?? "", app.bundleIdentifier ?? "", result, screenshotBounds, pid)
}

final class AXSettleTracker {
    private let lock = NSLock()
    private var count = 0
    private var lastEvent = ProcessInfo.processInfo.systemUptime

    func record() {
        lock.lock()
        count += 1
        lastEvent = ProcessInfo.processInfo.systemUptime
        lock.unlock()
    }

    func snapshot() -> (count: Int, lastEvent: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        return (count, lastEvent)
    }
}

func axSettleCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString, _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    Unmanaged<AXSettleTracker>.fromOpaque(refcon).takeUnretainedValue().record()
}

struct AXSettleObservation {
    let observer: AXObserver
    let tracker: AXSettleTracker
    let source: CFRunLoopSource
}

func beginAXSettleObservation(pid: pid_t) -> AXSettleObservation? {
    var observer: AXObserver?
    guard AXObserverCreate(pid, axSettleCallback, &observer) == .success, let observer else { return nil }
    let tracker = AXSettleTracker()
    let application = AXUIElementCreateApplication(pid)
    let notifications = [
        "AXValueChanged", "AXTitleChanged", "AXFocusedUIElementChanged", "AXFocusedWindowChanged",
        "AXWindowCreated", "AXUIElementDestroyed", "AXLayoutChanged", "AXSelectedChildrenChanged",
        "AXMenuOpened", "AXMenuClosed", "AXRowCountChanged",
    ]
    var registered = 0
    let refcon = Unmanaged.passUnretained(tracker).toOpaque()
    for notification in notifications {
        if AXObserverAddNotification(observer, application, notification as CFString, refcon) == .success { registered += 1 }
    }
    guard registered > 0 else { return nil }
    let source = AXObserverGetRunLoopSource(observer)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    return AXSettleObservation(observer: observer, tracker: tracker, source: source)
}

func finishAXSettleObservation(
    _ observation: AXSettleObservation?,
    minimum: TimeInterval = 0.18,
    quietWindow: TimeInterval = 0.25,
    maximum: TimeInterval = 5.0
) -> (durationMs: Int, eventCount: Int, source: String) {
    let started = ProcessInfo.processInfo.systemUptime
    guard let observation else {
        let fallback = max(0.0, min(minimum, maximum))
        usleep(useconds_t((fallback * 1_000_000).rounded()))
        return (Int((fallback * 1000).rounded()), 0, "bounded-fallback")
    }
    while ProcessInfo.processInfo.systemUptime - started < maximum {
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.025))
        let now = ProcessInfo.processInfo.systemUptime
        let state = observation.tracker.snapshot()
        if now - started >= minimum && now - state.lastEvent >= quietWindow { break }
    }
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), observation.source, .defaultMode)
    let state = observation.tracker.snapshot()
    return (Int(((ProcessInfo.processInfo.systemUptime - started) * 1000).rounded()), state.count, "ax-observer")
}

struct AXObserverCommand: Codable {
    let id: Int
    let command: String
    let target: String?
    let baseline: Int?
    let minimumMs: Int?
    let quietMs: Int?
    let maximumMs: Int?
}

func runAXObserverServer() {
    var observations: [String: AXSettleObservation] = [:]
    while let line = readLine() {
        var response: [String: Any] = [:]
        do {
            let command = try JSONDecoder().decode(AXObserverCommand.self, from: Data(line.utf8))
            response["id"] = command.id
            response["source"] = "macos-ax-service"
            switch command.command {
            case "ping": response["ok"] = true
            case "watch":
                guard let target = command.target, let pid = Int32(target) else { throw NSError(domain: "AXObserverServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid macOS observer target"]) }
                if observations[target] == nil { observations[target] = beginAXSettleObservation(pid: pid) }
                guard let observation = observations[target] else { throw NSError(domain: "AXObserverServer", code: 2, userInfo: [NSLocalizedDescriptionKey: "macOS AXObserver is unavailable"]) }
                response["ok"] = true
                response["generation"] = observation.tracker.snapshot().count
            case "wait":
                guard let target = command.target, let observation = observations[target] else { throw NSError(domain: "AXObserverServer", code: 3, userInfo: [NSLocalizedDescriptionKey: "macOS target is not watched"]) }
                let started = ProcessInfo.processInfo.systemUptime
                let minimum = Double(max(0, min(command.minimumMs ?? 180, 5000))) / 1000
                let quiet = Double(max(0, min(command.quietMs ?? 250, 5000))) / 1000
                let maximum = Double(max(1, min(command.maximumMs ?? 5000, 10000))) / 1000
                while ProcessInfo.processInfo.systemUptime - started < maximum {
                    _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.025))
                    let now = ProcessInfo.processInfo.systemUptime
                    if now - started >= minimum && now - observation.tracker.snapshot().lastEvent >= quiet { break }
                }
                let state = observation.tracker.snapshot()
                response["ok"] = true
                response["durationMs"] = Int(((ProcessInfo.processInfo.systemUptime - started) * 1000).rounded())
                response["eventCount"] = max(0, state.count - (command.baseline ?? 0))
                response["generation"] = state.count
            case "unwatch":
                if let target = command.target, let observation = observations.removeValue(forKey: target) {
                    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), observation.source, .defaultMode)
                }
                response["ok"] = true
            default: throw NSError(domain: "AXObserverServer", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unsupported observer command"])
            }
        } catch {
            response["ok"] = false
            response["error"] = error.localizedDescription
        }
        let data = try! JSONSerialization.data(withJSONObject: response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

func runNativeRequestServer() async {
    let maximumRequestBytes = 1 * 1024 * 1024
    while let line = readLine() {
        var response: [String: Any] = [:]
        do {
            guard line.utf8.count <= maximumRequestBytes,
                  let envelope = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let id = envelope["id"] as? NSNumber,
                  envelope["command"] as? String == "request",
                  let payload = envelope["payload"] as? [String: Any] else {
                throw NSError(domain: "NativeRequestServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid native request envelope"])
            }
            response["id"] = id
            let input = try JSONSerialization.data(withJSONObject: payload)
            let output = try await performIsolatedRequest(input, executableURL: URL(fileURLWithPath: processArguments[0]))
            response["transport"] = "persistent-broker"
            guard let result = try JSONSerialization.jsonObject(with: output) as? [String: Any] else {
                throw NSError(domain: "NativeRequestServer", code: 2, userInfo: [NSLocalizedDescriptionKey: "Native helper child returned invalid JSON"])
            }
            response["ok"] = true
            response["result"] = result
        } catch {
            response["ok"] = false
            response["error"] = error.localizedDescription
        }
        let data = try! JSONSerialization.data(withJSONObject: response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

func performAXElementAction(_ request: ElementActionRequest) -> ElementActionResult {
    guard let decoded = axDecodeElementId(request.elementId), let element = axResolve(pid: decoded.pid, path: decoded.path) else { fail("The macOS accessibility snapshot is stale; refresh computer_elements.") }
    let action = request.action
    let settleObservation = request.eventObserverActive == true ? nil : beginAXSettleObservation(pid: decoded.pid)
    var error: AXError = .success
    switch action {
    case "click":
        guard let bounds = axRect(element), bounds.width > 0, bounds.height > 0 else { fail("macOS accessibility element has no visible click bounds") }
        let point = CGPoint(x: CGFloat(bounds.x + bounds.width / 2), y: CGFloat(bounds.y + bounds.height / 2))
        postMouseMove(point, targetPid: decoded.pid)
        postClick(point, button: mouseButton(request.button), count: max(1, min(request.count ?? 1, 3)), targetPid: decoded.pid)
    case "press", "toggle": error = AXUIElementPerformAction(element, kAXPressAction as CFString)
    case "focus": error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    case "set_value": error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, (request.value ?? "") as CFTypeRef)
    case "increment": error = AXUIElementPerformAction(element, kAXIncrementAction as CFString)
    case "decrement": error = AXUIElementPerformAction(element, kAXDecrementAction as CFString)
    case "scroll_into_view":
        error = AXUIElementPerformAction(element, "AXScrollToVisible" as CFString)
        if error != .success { error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
    case "scroll":
        guard let bounds = axRect(element), bounds.width > 0, bounds.height > 0 else { fail("macOS accessibility element has no visible scroll bounds") }
        postMouseMove(CGPoint(x: CGFloat(bounds.x + bounds.width / 2), y: CGFloat(bounds.y + bounds.height / 2)), targetPid: decoded.pid)
        let direction = request.direction ?? "down"
        let amount = Int32(max(1, min(request.pages ?? 1, 100)) * 8)
        let horizontal = direction == "left" || direction == "right"
        let sign: Int32 = direction == "up" || direction == "left" ? 1 : -1
        postEvent(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: horizontal ? 0 : sign * amount, wheel2: horizontal ? sign * amount : 0, wheel3: 0), targetPid: decoded.pid)
    case "select_text":
        let needle = request.text ?? ""
        guard !needle.isEmpty else { fail("select_text requires non-empty text") }
        let source = axString(element, kAXValueAttribute as CFString)
        let nsSource = source as NSString
        let requiredPrefix = request.prefix ?? ""
        let requiredSuffix = request.suffix ?? ""
        var search = NSRange(location: 0, length: nsSource.length)
        var matched: NSRange? = nil
        while search.length > 0 {
            let candidate = nsSource.range(of: needle, options: [], range: search)
            if candidate.location == NSNotFound { break }
            let before = nsSource.substring(to: candidate.location)
            let after = nsSource.substring(from: candidate.location + candidate.length)
            if (requiredPrefix.isEmpty || before.hasSuffix(requiredPrefix)) && (requiredSuffix.isEmpty || after.hasPrefix(requiredSuffix)) {
                matched = candidate; break
            }
            let next = candidate.location + max(1, candidate.length)
            search = NSRange(location: next, length: max(0, nsSource.length - next))
        }
        guard var selected = matched else { fail("Text was not found in the macOS accessibility element") }
        if request.selectionType == "cursor_before" { selected.length = 0 }
        else if request.selectionType == "cursor_after" { selected.location += selected.length; selected.length = 0 }
        var cfRange = CFRange(location: selected.location, length: selected.length)
        guard let rangeValue = AXValueCreate(.cfRange, &cfRange) else { fail("Could not create macOS text selection range") }
        error = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue)
    case let native where native.hasPrefix("native:"):
        let nativeAction = String(native.dropFirst("native:".count))
        guard axActions(element).contains(nativeAction) else { fail("Element does not expose native accessibility action \(nativeAction)") }
        error = AXUIElementPerformAction(element, nativeAction as CFString)
    default: fail("Unsupported macOS element action: \(action)")
    }
    if error != .success { fail("macOS accessibility action \(action) failed with AXError \(error.rawValue)") }
    let settle = request.eventObserverActive == true
        ? (durationMs: 0, eventCount: 0, source: "external-observer-pending")
        : finishAXSettleObservation(settleObservation)
    return ElementActionResult(ok: true, source: "macos-ax", action: action, settleDurationMs: settle.durationMs, settleEventCount: settle.eventCount, settleSource: settle.source)
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
        // On current macOS releases SCScreenshotManager can be usable even
        // while the legacy CoreGraphics preflight flag remains false. Probe
        // the exact capture path this helper uses before reporting failure.
        if await screenshotBase64() != nil {
            let session = sessionGuard()
            permissions = Permissions(accessibility: true, screenRecording: true, interactiveDesktop: session.interactive, screenLocked: session.locked)
        }
    }
    if shouldPrompt && permissions.accessibility && !permissions.screenRecording {
        // CGRequestScreenCaptureAccess schedules system UI asynchronously.
        // Keep the named app alive while the user opens System Settings and
        // toggles the permission, otherwise macOS can discard the pending UI.
        for _ in 0..<120 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            let granted = await MainActor.run { screenRecordingAllowed(prompt: false) }
            if granted {
                let session = sessionGuard()
                permissions = Permissions(accessibility: true, screenRecording: true, interactiveDesktop: session.interactive, screenLocked: session.locked)
                break
            }
        }
    }

    let mutatesDesktop = request.elementAction != nil
        || request.windowAction != nil
        || !(request.targetApplication ?? "").isEmpty
        || (request.actions ?? []).contains { $0.action != "screenshot" && $0.action != "wait" }
    if mutatesDesktop && !permissions.interactiveDesktop {
        fail(permissions.screenLocked
            ? "The macOS screen is locked; unlock it before sending computer input."
            : "No interactive macOS console session is available for computer input.")
    }

    if let target = request.targetApplication, !target.isEmpty {
        ensureApplication(target, activate: request.activateTargetApplication ?? true)
    }

    var actionDisplay = resolutions.display
    var actionApi = resolutions.api
    var actionOrigin = CGPoint.zero
    var backgroundInputPid: pid_t? = nil
    var backgroundScreenshotBounds: RectInfo? = nil
    if let target = request.targetApplication, !target.isEmpty, request.activateTargetApplication == false {
        guard let windowTarget = applicationWindowTarget(target) else { fail("No targetable window is available for background input: \(target)") }
        actionDisplay = Resolution(width: windowTarget.bounds.width, height: windowTarget.bounds.height)
        actionApi = Resolution(width: apiWidth, height: max(1, Int((Double(apiWidth) * Double(windowTarget.bounds.height) / Double(windowTarget.bounds.width)).rounded())))
        actionOrigin = CGPoint(x: windowTarget.bounds.x, y: windowTarget.bounds.y)
        backgroundInputPid = windowTarget.pid
        backgroundScreenshotBounds = windowTarget.bounds
    }

    if (!(request.actions ?? []).isEmpty || request.includeElements == true || request.elementAction != nil || request.windowAction != nil) && !permissions.accessibility {
        fail("Accessibility permission is required. Enable this helper in System Settings > Privacy & Security > Accessibility.")
    }
    var elementActionResult: ElementActionResult? = nil
    if let elementAction = request.elementAction { elementActionResult = performAXElementAction(elementAction) }
    var windowActionResult: WindowActionResult? = nil
    if let windowAction = request.windowAction { windowActionResult = performAXWindowAction(windowAction, display: resolutions.display, api: resolutions.api) }
    let rawActions = request.actions ?? []
    let mutatingRawAction = rawActions.contains { $0.action != "screenshot" && $0.action != "wait" }
    let rawTargetPid = backgroundInputPid ?? (mutatingRawAction ? NSWorkspace.shared.frontmostApplication?.processIdentifier : nil)
    let rawSettleObservation = rawTargetPid.flatMap(beginAXSettleObservation)
    for action in rawActions { perform(action, display: actionDisplay, api: actionApi, origin: actionOrigin, targetPid: backgroundInputPid) }
    if mutatingRawAction {
        // Coordinate actions still need an act-then-observe settle phase. A
        // longer minimum than element actions prevents a fast route change in
        // an Electron/WKWebView app from returning an intermediate frame.
        _ = finishAXSettleObservation(rawSettleObservation, minimum: 0.8, quietWindow: 0.45, maximum: 5.0)
    }

    var elementApplication: String? = nil
    var elementApplicationId: String? = nil
    var elements: [ElementInfo]? = nil
    var applicationScreenshotBounds: RectInfo? = nil
    var applicationScreenshotPid: pid_t? = nil
    if request.includeElements == true {
        let listed = listAXElements(options: request.elementOptions)
        elementApplication = listed.application
        elementApplicationId = listed.applicationId
        elements = listed.elements
        applicationScreenshotBounds = listed.screenshotBounds
        applicationScreenshotPid = listed.applicationPid
    }

    let cursor = backgroundInputPid == nil ? apiPoint(CGEvent(source: nil)?.location ?? .zero, display: resolutions.display, api: resolutions.api) : nil
    let capture = request.includeScreenshot ?? true
    let captureBounds = request.includeElements == true ? applicationScreenshotBounds : backgroundScreenshotBounds
    let capturePid = request.includeElements == true ? applicationScreenshotPid : backgroundInputPid
    let screenshot = capture ? await screenshotBase64(bounds: captureBounds, applicationPid: capturePid) : nil
    if capture && screenshot == nil { fail("Screen Recording permission is required to capture the desktop.") }
    emit(Response(
        ok: true,
        displayResolution: backgroundInputPid == nil ? resolutions.display : actionDisplay,
        apiResolution: backgroundInputPid == nil ? resolutions.api : actionApi,
        cursorPosition: cursor,
        activeWindow: activeWindow(),
        windows: (request.includeWindows ?? false) ? visibleWindows() : [],
        screenshotMimeType: screenshot == nil ? nil : "image/png",
        screenshotBase64: screenshot,
        screenshotScope: screenshot == nil ? nil : (captureBounds == nil ? "desktop" : "application"),
        screenshotBounds: captureBounds,
        screenshotApplicationPid: capturePid.map(Int.init),
        permissions: permissions,
        elementSource: request.includeElements == true ? "macos-ax" : nil,
        elementApplication: elementApplication,
        elementApplicationId: elementApplicationId,
        elements: elements,
        elementMessage: elements == nil ? nil : "Returned \(elements!.count) macOS accessibility elements.",
        elementActionResult: elementActionResult,
        applications: request.listApplications == true ? installedApplications() : nil,
        windowActionResult: windowActionResult
    ))
}

#if REQUEST_XPC_SERVICE
runComputerRequestXPCService()
#else
if processArguments.contains("--request-server") {
    Task {
        await runNativeRequestServer()
        exit(0)
    }
    RunLoop.main.run()
} else if processArguments.contains("--observer-server") {
    runAXObserverServer()
} else {
    Task { await runHelper() }
    RunLoop.main.run()
}
#endif
