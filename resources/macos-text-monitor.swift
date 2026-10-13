import Cocoa
import Foundation
import Darwin

let TIMEOUT_SECONDS: Double = 30.0
let MAX_OUTPUT_BYTES = 10240
let MAX_BASE64_SOURCE_CHARS = 7000

var monitoredElement: AXUIElement?
var observer: AXObserver?
var monitoredPid: pid_t = 0

func writeOutput(_ message: String) {
    FileHandle.standardOutput.write((message + "\n").data(using: .utf8)!)
    fflush(stdout)
}

func writeError(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func writeTextOutput(_ prefix: String, _ value: String) {
    let truncated = String(value.prefix(MAX_OUTPUT_BYTES))
    if truncated.contains("\n") || truncated.contains("\r") {
        let capped = String(truncated.prefix(MAX_BASE64_SOURCE_CHARS))
        let encoded = Data(capped.utf8).base64EncodedString()
        writeOutput("\(prefix)_B64:\(encoded)")
        return
    }

    writeOutput("\(prefix):\(truncated)")
}

func readWindowBounds(_ appElement: AXUIElement, attribute: CFString) ->
    (x: Int, y: Int, width: Int, height: Int)? {
    var windowValue: AnyObject?
    guard AXUIElementCopyAttributeValue(appElement, attribute, &windowValue) == .success,
          let windowValue else { return nil }
    let windowElement = windowValue as! AXUIElement

    var positionValue: AnyObject?
    var sizeValue: AnyObject?
    guard AXUIElementCopyAttributeValue(
        windowElement,
        kAXPositionAttribute as CFString,
        &positionValue
    ) == .success,
    AXUIElementCopyAttributeValue(
        windowElement,
        kAXSizeAttribute as CFString,
        &sizeValue
    ) == .success,
    let positionValue,
    let sizeValue,
    CFGetTypeID(positionValue) == AXValueGetTypeID(),
    CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else { return nil }

    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
          position.x.isFinite,
          position.y.isFinite,
          size.width.isFinite,
          size.height.isFinite,
          size.width > 0,
          size.height > 0
    else { return nil }

    return (Int(position.x), Int(position.y), Int(size.width), Int(size.height))
}

func isEditableTextElement(_ element: AXUIElement) -> Bool {
    // A live selection means an editable verdict would let generated text
    // paste over the user's highlighted text (--editable-target mode probes
    // an element whose selection state the caller could not read itself).
    var selectedTextValue: AnyObject?
    if AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        &selectedTextValue
    ) == .success, let selectedText = selectedTextValue as? String, !selectedText.isEmpty {
        return false
    }

    var enabledValue: AnyObject?
    if AXUIElementCopyAttributeValue(
        element,
        kAXEnabledAttribute as CFString,
        &enabledValue
    ) == .success, let enabled = enabledValue as? Bool, !enabled {
        return false
    }

    var subroleValue: AnyObject?
    if AXUIElementCopyAttributeValue(
        element,
        kAXSubroleAttribute as CFString,
        &subroleValue
    ) == .success, subroleValue as? String == "AXSecureTextField" {
        return false
    }

    var roleValue: AnyObject?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXRoleAttribute as CFString,
        &roleValue
    ) == .success, let role = roleValue as? String,
          ["AXTextField", "AXTextArea", "AXComboBox"].contains(role)
    else {
        return false
    }

    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(
        element,
        kAXValueAttribute as CFString,
        &settable
    ) == .success, settable.boolValue {
        return true
    }

    settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(
        element,
        kAXSelectedTextAttribute as CFString,
        &settable
    ) == .success && settable.boolValue
}

// The app's focused window, only when it is a standard one with the keyboard
// in its content. A sheet, dialog, panel or floating window is never a paste
// target: Return in a sheet presses its default button.
func focusedStandardWindow(_ appElement: AXUIElement) -> AXUIElement? {
    guard let windowElement = accessibilityElement(appElement, kAXFocusedWindowAttribute as String)
    else { return nil }
    var subroleValue: AnyObject?
    guard AXUIElementCopyAttributeValue(
        windowElement,
        kAXSubroleAttribute as CFString,
        &subroleValue
    ) == .success,
    (subroleValue as? String) == (kAXStandardWindowSubrole as String),
    keyboardFocusIsInWindowContent(appElement, windowElement)
    else { return nil }
    return windowElement
}

// The window-server number behind an accessibility window element. Private,
// but long stable and what window managers use; matching a window by its frame
// instead cannot tell two windows at the same position apart.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(
    _ element: AXUIElement,
    _ windowID: UnsafeMutablePointer<CGWindowID>
) -> AXError

func accessibilityElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
          let value,
          CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
}

func accessibilityRole(_ element: AXUIElement) -> String? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success
    else { return nil }
    return value as? String
}

// True when keys go to the terminal content of this window. An attached sheet
// can leave its parent reported as the focused window, so the window must have
// no sheet. The app's focused element must be a text area (a find bar is a
// text field in the same window) and must name this window as its own: an
// element inside a sheet or dialog names that instead. Anything that cannot
// be read, and a window with more children than a terminal has, counts as "no".
func keyboardFocusIsInWindowContent(_ appElement: AXUIElement, _ windowElement: AXUIElement) -> Bool {
    var childrenValue: AnyObject?
    guard AXUIElementCopyAttributeValue(
        windowElement,
        kAXChildrenAttribute as CFString,
        &childrenValue
    ) == .success,
    let children = childrenValue as? [AXUIElement],
    children.count <= 64
    else { return false }
    for child in children {
        guard let role = accessibilityRole(child), role != (kAXSheetRole as String)
        else { return false }
    }
    guard let focused = accessibilityElement(appElement, kAXFocusedUIElementAttribute as String),
          accessibilityRole(focused) == (kAXTextAreaRole as String),
          let owner = accessibilityElement(focused, kAXWindowAttribute as String)
    else { return false }
    return CFEqual(owner, windowElement)
}

// Window-server number of the app's focused standard window. Keyboard focus
// decides, not stacking order. Anything that cannot be read is no answer.
func focusedWindowNumber(pid: pid_t) -> Int? {
    let appElement = AXUIElementCreateApplication(pid)
    // An app that does not answer must not hold up the key press or the paste.
    // Set on the system-wide element, the limit holds for every element read.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.2)
    guard let windowElement = focusedStandardWindow(appElement) else { return nil }
    var windowID: CGWindowID = 0
    guard _AXUIElementGetWindow(windowElement, &windowID) == .success, windowID != 0
    else { return nil }
    return Int(windowID)
}

// True while the app is frontmost and the given window has its keyboard focus.
func isPasteTarget(pid: pid_t, windowNumber: Int) -> Bool {
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid &&
        focusedWindowNumber(pid: pid) == windowNumber
}

// Set when any app became active or inactive, or the target app's focused or
// main window changed, while it was being watched.
final class FocusWatch {
    var changed = false
    // The text area that had the keyboard at the first check. A focus report
    // that names it again is not a change: Terminal sends one on every paste.
    var contentElement: AXUIElement?
    private var windowObserver: AXObserver?

    // False when the window watch could not be set up. No watch, no keys.
    func start(pid: pid_t) -> Bool {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didActivateApplicationNotification,
                     NSWorkspace.didDeactivateApplicationNotification] {
            center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.changed = true
            }
        }
        var created: AXObserver?
        guard AXObserverCreate(pid, focusWatchCallback, &created) == .success,
              let created else { return false }
        let appElement = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        // The keyboard moving to another element of the same window (a find
        // field) and back is only visible through the focused-element report,
        // so that one is required like the two window reports.
        for name in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification,
                     kAXFocusedUIElementChangedNotification] {
            guard AXObserverAddNotification(created, appElement, name as CFString, refcon) == .success
            else { return false }
        }
        // A sheet opening also withholds Return. Best effort: a sheet stays up,
        // and the check before Return looks for one again.
        _ = AXObserverAddNotification(
            created, appElement, kAXSheetCreatedNotification as CFString, refcon)
        CFRunLoopAddSource(
            CFRunLoopGetCurrent(),
            AXObserverGetRunLoopSource(created),
            .defaultMode
        )
        windowObserver = created
        return true
    }
}

func focusWatchCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else { return }
    let watch = Unmanaged<FocusWatch>.fromOpaque(refcon).takeUnretainedValue()
    if (notification as String) == (kAXFocusedUIElementChangedNotification as String),
       let content = watch.contentElement, CFEqual(element, content) {
        return
    }
    watch.changed = true
}

// Waits while the run loop turns: workspace notifications are delivered, and
// frontmostApplication is only refreshed, while it does. A run loop with no
// source returns at once, so the short sleep keeps the wait its full length.
func waitTurningRunLoop(_ seconds: TimeInterval) {
    let deadline = Date(timeIntervalSinceNow: seconds)
    while Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: deadline)
        usleep(2000)
    }
}

func readCurrentValue() -> String? {
    guard let element = monitoredElement else { return nil }
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
    guard result == .success, let str = value as? String else { return nil }
    return str
}

func observerCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    if let value = readCurrentValue() {
        writeTextOutput("CHANGED", value)
    }
}

// Usage: macos-text-monitor <pid>
//        macos-text-monitor --selected-text <pid>
//        macos-text-monitor --editable-target <pid>
//        macos-text-monitor --window-bounds <pid>
//        macos-text-monitor --frontmost-pid [--with-window]
//        macos-text-monitor --activate <pid>
//        macos-text-monitor --paste-return-to-pid <pid> <windowNumber>
//
// --frontmost-pid and --activate sit on the dictation hot paths (target capture at key press,
// target activation right before paste). Each used to be an
// `osascript -l JavaScript` round trip, measured at ~350 ms per call on Apple
// silicon; a direct NSWorkspace call from this binary is a process spawn.
if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--frontmost-pid" {
    if let app = NSWorkspace.shared.frontmostApplication {
        writeOutput("FRONTMOST_PID:\(app.processIdentifier)")
        // Only target capture asks for the window: it costs accessibility
        // calls into the frontmost app, which the other callers do not need.
        if CommandLine.arguments.contains("--with-window") {
            // Auto-submit picks terminals by exact bundle id (#634).
            if let bundleIdentifier = app.bundleIdentifier, !bundleIdentifier.isEmpty {
                writeOutput("FRONTMOST_BUNDLE:\(bundleIdentifier)")
            }
            if let windowNumber = focusedWindowNumber(pid: app.processIdentifier) {
                writeOutput("FRONTMOST_WINDOW:\(windowNumber)")
            }
        }
        exit(0)
    }
    writeOutput("FRONTMOST_PID:")
    exit(1)
}

if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--activate" {
    guard let activatePid = Int32(CommandLine.arguments[2]),
          let app = NSRunningApplication(processIdentifier: activatePid) else {
        writeOutput("ACTIVATE_FAILED")
        exit(1)
    }
    // Same options the JXA path passed as activateWithOptions(3): bring every
    // window forward and ignore the currently active app.
    app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    writeOutput("ACTIVATE_OK:\(activatePid)")
    exit(0)
}

// Auto-submit (#634): paste and press Return in one window of one process.
// Both keys go to the same pid: with Cmd+V on the session tap and Return on the
// pid, a focus bounce sent the text to another app and Return to the terminal
// without it. The window is checked before each key: a pid alone cannot tell
// two windows of one terminal apart, and both keys went to the other one. It
// is the window with keyboard focus, and only a standard one.
// Neither key is ever posted to a session or HID tap, which would hand it to
// whatever is frontmost. Any change of the active app or of the target's
// focused window while the keys are in flight withholds Return: a terminal
// that lost focus as Cmd+V arrived dropped the paste, and Return then ran the
// line without the dictated text.
if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--paste-return-to-pid" {
    guard CommandLine.arguments.count >= 4,
          let pastePid = Int32(CommandLine.arguments[2]),
          pastePid > 0,
          let pasteWindow = Int(CommandLine.arguments[3]),
          pasteWindow > 0 else {
        writeOutput("PASTE_FAILED")
        exit(1)
    }
    guard AXIsProcessTrusted() else {
        writeOutput("PASTE_FAILED")
        exit(2)
    }
    let focusWatch = FocusWatch()
    guard focusWatch.start(pid: pastePid),
          isPasteTarget(pid: pastePid, windowNumber: pasteWindow),
          let contentElement = accessibilityElement(
              AXUIElementCreateApplication(pastePid), kAXFocusedUIElementAttribute as String)
    else {
        writeOutput("PASTE_SKIPPED")
        exit(3)
    }
    focusWatch.contentElement = contentElement
    let vKey: CGKeyCode = 0x09
    let returnKey: CGKeyCode = 0x24
    guard let vDown = CGEvent(keyboardEventSource: nil, virtualKey: vKey, keyDown: true),
          let vUp = CGEvent(keyboardEventSource: nil, virtualKey: vKey, keyDown: false),
          let returnDown = CGEvent(keyboardEventSource: nil, virtualKey: returnKey, keyDown: true),
          let returnUp = CGEvent(keyboardEventSource: nil, virtualKey: returnKey, keyDown: false) else {
        writeOutput("PASTE_FAILED")
        exit(1)
    }
    vDown.flags = .maskCommand
    vUp.flags = .maskCommand
    vDown.postToPid(pastePid)
    waitTurningRunLoop(0.008)
    vUp.postToPid(pastePid)
    // From here the text is out: a caller that sees only this line must not
    // paste again.
    writeOutput("PASTE_SENT:\(pastePid)")
    waitTurningRunLoop(0.15)
    // Return is withheld if focus changed at any point since the first check,
    // or if the target is no longer the focused window of the frontmost app.
    // The accessibility reads take time, so they come first and the watch is
    // read last, after one more turn of the run loop.
    let stillTarget = isPasteTarget(pid: pastePid, windowNumber: pasteWindow)
    waitTurningRunLoop(0.004)
    guard stillTarget, !focusWatch.changed,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pastePid else {
        writeOutput("PASTE_ONLY:\(pastePid)")
        exit(4)
    }
    returnDown.flags = []
    returnUp.flags = []
    returnDown.postToPid(pastePid)
    usleep(8000)
    returnUp.postToPid(pastePid)
    usleep(20000)
    writeOutput("PASTE_RETURN_OK:\(pastePid)")
    exit(0)
}

let selectionReadMode = CommandLine.arguments.count >= 3 &&
    CommandLine.arguments[1] == "--selected-text"
let editableTargetMode = CommandLine.arguments.count >= 3 &&
    CommandLine.arguments[1] == "--editable-target"
let windowBoundsMode = CommandLine.arguments.count >= 3 &&
    CommandLine.arguments[1] == "--window-bounds"
let pidArgumentIndex = selectionReadMode || editableTargetMode || windowBoundsMode ? 2 : 1

guard CommandLine.arguments.count > pidArgumentIndex,
      let targetPid = Int32(CommandLine.arguments[pidArgumentIndex]),
      targetPid > 0 else {
    writeError("Usage: macos-text-monitor [--selected-text|--editable-target|--window-bounds] <pid>")
    writeOutput("NO_ELEMENT")
    exit(1)
}

monitoredPid = targetPid

// Reports the target's window rect so the caller can tell which display the user
// is working on. Prefer the user's focused window, then the app's main window.
// Some apps keep their AX tree dormant, so retain the window-server fallback.
if windowBoundsMode {
    let appElement = AXUIElementCreateApplication(targetPid)
    if let window = readWindowBounds(appElement, attribute: kAXFocusedWindowAttribute as CFString)
        ?? readWindowBounds(appElement, attribute: kAXMainWindowAttribute as CFString) {
        writeOutput("BOUNDS:\(window.x),\(window.y),\(window.width),\(window.height)")
        exit(0)
    }

    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    // Largest window rather than frontmost: layer 0 still includes the full-width
    // toolbar strips Arc-family browsers float above their content, and one of
    // those spanning another display would name the wrong screen.
    var best: (x: Int, y: Int, width: Int, height: Int, area: Double)?
    for window in windows {
        guard let ownerPid = window[kCGWindowOwnerPID as String] as? pid_t, ownerPid == targetPid,
              let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let x = bounds["X"] as? Double, let y = bounds["Y"] as? Double,
              let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double
        else { continue }
        let area = width * height
        if area > (best?.area ?? 0) {
            best = (Int(x), Int(y), Int(width), Int(height), area)
        }
    }

    guard let window = best else {
        writeOutput("NO_WINDOW")
        exit(1)
    }
    writeOutput("BOUNDS:\(window.x),\(window.y),\(window.width),\(window.height)")
    exit(0)
}

// Read original text from stdin (monitoring mode only). Selection reads are
// spawned via execFile, which keeps stdin open without writing — blocking on
// readLine there would hang until the caller's timeout kills the process.
var originalText = ""
if !selectionReadMode && !editableTargetMode, let line = readLine(strippingNewline: true) {
    originalText = line
}

// Target the specific application by PID (passed from the Electron host
// which captures it BEFORE the overlay steals focus).
let appElement = AXUIElementCreateApplication(monitoredPid)
let maxRetries = 5
var focusedElement: AXUIElement? = nil

for attempt in 1...maxRetries {
    var elementValue: AnyObject?
    let elementResult = AXUIElementCopyAttributeValue(
        appElement,
        kAXFocusedUIElementAttribute as CFString,
        &elementValue
    )

    if elementResult == .success, let element = elementValue {
        focusedElement = (element as! AXUIElement)
        if attempt > 1 {
            writeError("Got focused element on attempt \(attempt)")
        }
        break
    } else {
        writeError("Attempt \(attempt)/\(maxRetries): Cannot get focused element for PID \(monitoredPid) (error: \(elementResult.rawValue))")
    }

    if attempt < maxRetries {
        Thread.sleep(forTimeInterval: 0.3)
    }
}

guard let resolvedElement = focusedElement else {
    writeOutput("NO_ELEMENT")
    exit(1)
}

if editableTargetMode {
    writeOutput(isEditableTextElement(resolvedElement) ? "EDITABLE" : "NOT_EDITABLE")
    exit(0)
}

// Selection capture is a short-lived, read-only mode used before an AI edit.
// It deliberately uses the same AX client as the monitor so a packaged app's
// trusted native helper does not need to rely on System Events automation.
if selectionReadMode {
    var selectionValue: AnyObject?
    let selectionResult = AXUIElementCopyAttributeValue(
        resolvedElement,
        kAXSelectedTextAttribute as CFString,
        &selectionValue
    )

    if selectionResult == .success, let selection = selectionValue as? String {
        if selection.isEmpty {
            writeOutput(isEditableTextElement(resolvedElement) ? "EDITABLE_NONE:" : "NONE:")
        } else {
            writeTextOutput("SELECTED", selection)
        }
        exit(0)
    }

    if selectionResult == .noValue || selectionResult == .attributeUnsupported {
        writeOutput("NONE:")
        exit(0)
    }

    writeError("Cannot read selected text for PID \(monitoredPid) (error: \(selectionResult.rawValue))")
    writeOutput("UNAVAILABLE:")
    exit(1)
}

monitoredElement = resolvedElement
writeError("Monitoring element in PID \(monitoredPid)")

// Read initial value
guard let initialValue = readCurrentValue() else {
    writeError("Focused element has no text value")
    writeOutput("NO_VALUE")
    exit(0)
}

writeTextOutput("INITIAL_VALUE", initialValue)

// Create AXObserver for the target application's PID
var createdObserver: AXObserver?
let observerResult = AXObserverCreate(monitoredPid, observerCallback, &createdObserver)

guard observerResult == .success, let obs = createdObserver else {
    writeError("Failed to create AXObserver (error: \(observerResult.rawValue))")
    exit(1)
}

observer = obs

// Watch for value changes
let addResult = AXObserverAddNotification(
    obs,
    monitoredElement!,
    kAXValueChangedNotification as CFString,
    nil
)

if addResult != .success {
    writeError("Failed to add notification (error: \(addResult.rawValue))")
    exit(1)
}

// Add observer to run loop
CFRunLoopAddSource(
    CFRunLoopGetCurrent(),
    AXObserverGetRunLoopSource(obs),
    .commonModes
)

// Schedule auto-exit after timeout
DispatchQueue.main.asyncAfter(deadline: .now() + TIMEOUT_SECONDS) {
    CFRunLoopStop(CFRunLoopGetCurrent())
}

// Handle SIGTERM for clean exit
let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
signalSource.setEventHandler {
    CFRunLoopStop(CFRunLoopGetCurrent())
}
signalSource.resume()

CFRunLoopRun()
