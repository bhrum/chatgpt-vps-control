#!/usr/bin/env python3
import base64
import configparser
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback

try:
    import pyatspi
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"pyatspi is unavailable: {exc}"}))
    sys.exit(0)

INTERACTIVE_ROLES = {
    "button", "check box", "combo box", "entry", "link", "list box", "menu item",
    "page tab", "password text", "radio button", "scroll bar", "slider", "spin button",
    "table cell", "text", "toggle button", "tree item",
}
STATIC_ROLES = {"heading", "image", "label", "paragraph", "static", "status bar"}
CONTAINER_ROLES = {"application", "dialog", "document frame", "frame", "grouping", "menu", "panel", "section", "tool bar", "window"}
MAX_DEPTH = 18


ROLE_ALIASES = {
    "push button": "button",
    "pushbutton": "button",
    "password text": "entry",
}


def canonical_role(value):
    role = str(value or "unknown").strip().lower()
    return ROLE_ALIASES.get(role, role)


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def safe(call, default=None):
    try:
        return call()
    except Exception:
        return default


def session_guard():
    """Fail closed on a known locked/inactive logind session.

    Managed Xvfb desktops commonly have no logind session id; reachability of
    their private DISPLAY remains the authorization boundary in that mode.
    """
    session_id = str(os.environ.get("XDG_SESSION_ID", "") or "").strip()
    loginctl = shutil.which("loginctl")
    if not session_id or not loginctl:
        return {"interactiveDesktop": True, "screenLocked": False, "source": "display"}
    result = subprocess.run(
        [loginctl, "show-session", session_id, "--property=Active", "--property=LockedHint"],
        capture_output=True, text=True, timeout=3, check=False,
    )
    if result.returncode != 0:
        return {"interactiveDesktop": False, "screenLocked": True, "source": "logind-unavailable"}
    values = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key.strip()] = value.strip().lower()
    active = values.get("Active") == "yes"
    locked = values.get("LockedHint") == "yes"
    return {"interactiveDesktop": active and not locked, "screenLocked": locked, "source": "logind"}


def encode_id(path):
    raw = json.dumps({"source": "linux-atspi", "path": path}, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_id(value):
    padded = str(value) + "=" * ((4 - len(str(value)) % 4) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    if payload.get("source") != "linux-atspi" or not isinstance(payload.get("path"), list):
        raise ValueError("Invalid AT-SPI element id")
    return [int(part) for part in payload["path"]]


def state_has(obj, state):
    states = safe(lambda: obj.getState(), None)
    return bool(states and states.contains(state))


def child_at(obj, index):
    return safe(lambda: obj.getChildAtIndex(index), None)


def resolve_path(path):
    obj = pyatspi.Registry.getDesktop(0)
    for index in path:
        obj = child_at(obj, index)
        if obj is None:
            raise ValueError("The accessibility snapshot is stale; element path no longer exists")
    return obj


def action_names(obj):
    iface = safe(lambda: obj.queryAction(), None)
    if iface is None:
        return [], None
    names = []
    for i in range(safe(lambda: iface.nActions, 0) or 0):
        name = safe(lambda i=i: iface.getName(i), "") or ""
        names.append(str(name))
    return names, iface


def attribute_map(obj):
    result = {}
    for raw in safe(lambda: obj.getAttributes(), []) or []:
        key, separator, value = str(raw).partition(":")
        if separator:
            result[key.strip().lower()] = value.strip()
    return result


def desktop_application_entries():
    entries = []
    roots = ["/usr/share/applications", "/usr/local/share/applications"]
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    roots.insert(0, os.path.join(data_home, "applications"))
    seen = set()
    for root in roots:
        if not os.path.isdir(root):
            continue
        for filename in sorted(os.listdir(root)):
            if not filename.endswith(".desktop") or filename in seen:
                continue
            path = os.path.join(root, filename)
            parser = configparser.ConfigParser(interpolation=None, strict=False)
            try:
                parser.read(path, encoding="utf-8")
                entry = parser["Desktop Entry"]
                if entry.getboolean("NoDisplay", fallback=False) or entry.get("Type", "Application") != "Application":
                    continue
                seen.add(filename)
                entries.append({"id": f"desktop:{filename[:-8]}", "desktopId": filename[:-8], "displayName": entry.get("Name", filename[:-8]).strip(), "path": path})
            except Exception:
                continue
            if len(entries) >= 400:
                return entries
    return entries


def text_value(obj):
    editable = safe(lambda: obj.queryEditableText(), None)
    text = safe(lambda: obj.queryText(), None)
    if text is None:
        return "", editable is not None
    count = safe(lambda: text.characterCount, 0) or 0
    value = safe(lambda: text.getText(0, min(count, 4000)), "") or ""
    return str(value), editable is not None


def value_info(obj):
    iface = safe(lambda: obj.queryValue(), None)
    if iface is None:
        return None
    return {
        "current": safe(lambda: float(iface.currentValue), None),
        "minimum": safe(lambda: float(iface.minimumValue), None),
        "maximum": safe(lambda: float(iface.maximumValue), None),
        "increment": safe(lambda: float(iface.minimumIncrement), None),
    }


def bounds_info(obj):
    component = safe(lambda: obj.queryComponent(), None)
    if component is None:
        return None
    extents = safe(lambda: component.getExtents(pyatspi.DESKTOP_COORDS), None)
    if extents is None:
        return None
    values = [int(extents.x), int(extents.y), int(extents.width), int(extents.height)]
    if values[2] < 0 or values[3] < 0 or abs(values[0]) > 1000000 or abs(values[1]) > 1000000:
        return None
    return {"x": values[0], "y": values[1], "width": values[2], "height": values[3]}


def semantic_actions(obj, role, native_actions, editable, has_value):
    actions = []
    if native_actions or role in INTERACTIVE_ROLES:
        actions.extend(["press", "click"])
    if safe(lambda: obj.queryComponent(), None) is not None:
        actions.extend(["click", "focus", "scroll_into_view", "scroll"])
    if editable:
        actions.extend(["set_value", "select_text"])
    if role in {"check box", "radio button", "toggle button"}:
        actions.append("toggle")
    if has_value:
        actions.extend(["increment", "decrement"])
    return list(dict.fromkeys(actions))


def element_info(obj, path, depth):
    role = canonical_role(safe(lambda: obj.getRoleName(), "unknown"))
    native_actions, _ = action_names(obj)
    value, editable = text_value(obj)
    numeric = value_info(obj)
    attributes = attribute_map(obj)
    return {
        "id": encode_id(path),
        "role": role,
        "name": str(safe(lambda: obj.name, "") or "")[:1000],
        "value": value[:4000] if value else ("" if numeric is None else str(numeric.get("current") or "")),
        "description": str(safe(lambda: obj.description, "") or "")[:1000],
        "enabled": state_has(obj, pyatspi.STATE_ENABLED),
        "focused": state_has(obj, pyatspi.STATE_FOCUSED),
        "selected": state_has(obj, pyatspi.STATE_SELECTED),
        "checked": state_has(obj, pyatspi.STATE_CHECKED) if role in {"check box", "radio button", "toggle button"} else None,
        "expanded": state_has(obj, pyatspi.STATE_EXPANDED) if role in {"combo box", "menu", "tree item"} else None,
        "bounds": bounds_info(obj),
        "actions": semantic_actions(obj, role, native_actions, editable, numeric is not None),
        "nativeActions": native_actions,
        "subrole": attributes.get("class", attributes.get("xml-roles", "")),
        "identifier": attributes.get("id", attributes.get("automation-id", attributes.get("accessible-id", ""))),
        "placeholder": attributes.get("placeholder-text", attributes.get("placeholder", "")),
        "url": attributes.get("url", attributes.get("uri", ""))[:4000],
        "depth": depth,
        "toolkit": attributes.get("toolkit", ""),
    }


def interesting(obj, include_static, include_containers=False):
    role = canonical_role(safe(lambda: obj.getRoleName(), ""))
    if role in INTERACTIVE_ROLES:
        return True
    if state_has(obj, pyatspi.STATE_FOCUSABLE):
        return True
    if include_static and role in STATIC_ROLES:
        return True
    if include_containers and role in CONTAINER_ROLES and str(safe(lambda: obj.name, "") or "").strip():
        return True
    return False


def list_elements(request):
    desktop = pyatspi.Registry.getDesktop(0)
    max_elements = max(1, min(int(request.get("maxElements", 120)), 500))
    include_static = bool(request.get("includeStaticText", False))
    include_containers = bool(request.get("includeContainers", False))
    role_filter = canonical_role(request.get("role", "")) if request.get("role", "") else ""
    query = str(request.get("query", request.get("name", "")) or "").strip().lower()
    application_id = str(request.get("application", "") or "").strip()
    application = application_id.lower()
    requested_desktop_id = ""
    if application.startswith("desktop:"):
        requested_desktop_id = application[8:]
        entry = next((item for item in desktop_application_entries() if item["desktopId"].lower() == requested_desktop_id), None)
        application = entry["displayName"].lower() if entry else requested_desktop_id
    if application.startswith("atspi:"):
        application = application[6:]
    result = []
    selected_application = ""
    selected_application_id = ""
    selected_application_object = None

    def has_application():
        count = int(safe(lambda: desktop.childCount, 0) or 0)
        for index in range(min(count, 100)):
            candidate = child_at(desktop, index)
            candidate_name = str(safe(lambda: candidate.name, "") or "").strip().lower()
            if candidate_name and (candidate_name == application or application in candidate_name):
                return True
        return False

    if request.get("launchIfNeeded") and requested_desktop_id and application and not has_application() and shutil.which("gtk-launch"):
        subprocess.Popen(["gtk-launch", requested_desktop_id], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(20):
            time.sleep(0.1)
            desktop = pyatspi.Registry.getDesktop(0)
            if has_application():
                break

    def walk(obj, path, depth):
        if obj is None or depth > MAX_DEPTH or len(result) >= max_elements:
            return
        if depth > 0 and interesting(obj, include_static, include_containers):
            info = element_info(obj, path, depth)
            searchable = f"{info['name']} {info['description']} {info['value']}".lower()
            if (not role_filter or info["role"] == role_filter) and (not query or query in searchable):
                result.append(info)
                if len(result) >= max_elements:
                    return
        count = safe(lambda: obj.childCount, 0) or 0
        for index in range(min(int(count), 500)):
            if len(result) >= max_elements:
                return
            walk(child_at(obj, index), path + [index], depth + 1)

    app_count = safe(lambda: desktop.childCount, 0) or 0
    applications = []
    for app_index in range(min(int(app_count), 100)):
        app = child_at(desktop, app_index)
        if app is None:
            continue
        app_name = str(safe(lambda: app.name, "") or "")
        applications.append({"index": app_index, "name": app_name})
        normalized_name = app_name.strip().lower()
        if application and application != normalized_name and application not in normalized_name:
            continue
        if application and not selected_application:
            selected_application = app_name
            selected_application_object = app
            selected_application_id = (
                application_id
                if application_id.startswith(("atspi:", "desktop:"))
                else f"atspi:{normalized_name}"
            )
        walk(app, [app_index], 0)

    screenshot = None
    screenshot_bounds = None
    if request.get("includeScreenshot") and selected_application_object is not None and shutil.which("ffmpeg"):
        candidates = []
        child_count = int(safe(lambda: selected_application_object.childCount, 0) or 0)
        for child_index in range(min(child_count, 100)):
            child = child_at(selected_application_object, child_index)
            bounds = bounds_info(child) if child is not None else None
            if bounds and bounds["width"] > 0 and bounds["height"] > 0:
                active = bool(safe(lambda: child.getState().contains(pyatspi.STATE_ACTIVE), False))
                candidates.append((not active, bounds))
        if candidates:
            screenshot_bounds = sorted(candidates, key=lambda item: item[0])[0][1]
            x = max(0, int(screenshot_bounds["x"])); y = max(0, int(screenshot_bounds["y"]))
            width = max(1, min(16384, int(screenshot_bounds["width"]))); height = max(1, min(16384, int(screenshot_bounds["height"])))
            screenshot_bounds = {"x": x, "y": y, "width": width, "height": height}
            display = os.environ.get("DISPLAY", ":0")
            captured = subprocess.run([
                "ffmpeg", "-loglevel", "error", "-nostdin", "-f", "x11grab", "-video_size", f"{width}x{height}",
                "-i", f"{display}+{x},{y}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1",
            ], capture_output=True, timeout=8, check=False)
            if captured.returncode == 0 and captured.stdout:
                screenshot = base64.b64encode(captured.stdout).decode("ascii")

    return {
        "ok": True,
        "source": "linux-atspi",
        "applications": applications,
        "application": selected_application or None,
        "applicationId": selected_application_id or None,
        "elements": result,
        "screenshotMimeType": "image/png" if screenshot else None,
        "screenshotBase64": screenshot,
        "screenshotScope": "application" if screenshot else None,
        "screenshotBounds": screenshot_bounds if screenshot else None,
        "message": f"Returned {len(result)} AT-SPI accessibility elements.",
    }


def choose_native_action(names):
    preferred = ["click", "press", "activate", "open", "toggle", "select"]
    lowered = [name.lower() for name in names]
    for choice in preferred:
        for index, name in enumerate(lowered):
            if choice in name:
                return index
    return 0 if names else None


def begin_atspi_settle(target_application_name):
    try:
        from gi.repository import GLib
    except Exception:
        return None
    tracker = {"count": 0, "last": time.monotonic()}
    lock = threading.Lock()
    event_types = [
        "object:property-change", "object:state-changed", "object:children-changed",
        "object:text-changed", "object:text-caret-moved", "object:selection-changed", "window",
    ]

    def listener(event):
        host_name = str(safe(lambda: event.host_application.name, "") or "")
        if target_application_name and host_name and host_name != target_application_name:
            return
        with lock:
            tracker["count"] += 1
            tracker["last"] = time.monotonic()

    registered = []
    for event_type in event_types:
        try:
            pyatspi.Registry.registerEventListener(listener, event_type)
            registered.append(event_type)
        except Exception:
            pass
    if not registered:
        return None
    loop = GLib.MainLoop()
    thread = threading.Thread(target=loop.run, name="atspi-settle", daemon=True)
    thread.start()
    return {"tracker": tracker, "lock": lock, "listener": listener, "eventTypes": registered, "loop": loop, "thread": thread}


def finish_atspi_settle(observation):
    started = time.monotonic()
    if observation is None:
        time.sleep(0.18)
        return {"settleDurationMs": 180, "settleEventCount": 0, "settleSource": "bounded-fallback"}
    while time.monotonic() - started < 5.0:
        with observation["lock"]:
            last_event = observation["tracker"]["last"]
        if time.monotonic() - started >= 0.18 and time.monotonic() - last_event >= 0.25:
            break
        time.sleep(0.025)
    for event_type in observation["eventTypes"]:
        safe(lambda event_type=event_type: pyatspi.Registry.deregisterEventListener(observation["listener"], event_type), None)
    observation["loop"].quit()
    observation["thread"].join(timeout=0.5)
    with observation["lock"]:
        count = observation["tracker"]["count"]
    return {
        "settleDurationMs": int(round((time.monotonic() - started) * 1000)),
        "settleEventCount": count,
        "settleSource": "atspi-events",
    }


def wait_atspi_service(observation, baseline, minimum_ms=180, quiet_ms=250, maximum_ms=5000):
    started = time.monotonic()
    minimum = max(0, min(int(minimum_ms), 5000)) / 1000.0
    quiet = max(0, min(int(quiet_ms), 5000)) / 1000.0
    maximum = max(1, min(int(maximum_ms), 10000)) / 1000.0
    while time.monotonic() - started < maximum:
        with observation["lock"]:
            last_event = observation["tracker"]["last"]
        now = time.monotonic()
        if now - started >= minimum and now - last_event >= quiet:
            break
        time.sleep(0.025)
    with observation["lock"]:
        count = observation["tracker"]["count"]
    return {
        "durationMs": int(round((time.monotonic() - started) * 1000)),
        "eventCount": max(0, count - int(baseline or 0)),
        "generation": count,
    }


def observer_server():
    observations = {}
    for raw in sys.stdin:
        request = {}
        try:
            request = json.loads(raw or "{}")
            command = str(request.get("command", ""))
            target = str(request.get("target", ""))
            if command == "ping":
                response = {"id": request.get("id"), "ok": True, "source": "linux-atspi-service"}
            elif command == "watch":
                index = int(target)
                desktop = pyatspi.Registry.getDesktop(0)
                application = child_at(desktop, index)
                if application is None:
                    raise RuntimeError("AT-SPI application target is stale")
                name = str(safe(lambda: application.name, "") or "")
                observation = observations.get(target)
                if observation is None:
                    observation = begin_atspi_settle(name)
                    if observation is None:
                        raise RuntimeError("AT-SPI event listener is unavailable")
                    observations[target] = observation
                with observation["lock"]:
                    generation = observation["tracker"]["count"]
                response = {"id": request.get("id"), "ok": True, "source": "linux-atspi-service", "generation": generation}
            elif command == "wait":
                observation = observations.get(target)
                if observation is None:
                    raise RuntimeError("AT-SPI target is not watched")
                settled = wait_atspi_service(
                    observation, request.get("baseline", 0), request.get("minimumMs", 180),
                    request.get("quietMs", 250), request.get("maximumMs", 5000),
                )
                response = {"id": request.get("id"), "ok": True, "source": "linux-atspi-service", **settled}
            elif command == "unwatch":
                observation = observations.pop(target, None)
                if observation is not None:
                    for event_type in observation["eventTypes"]:
                        safe(lambda event_type=event_type: pyatspi.Registry.deregisterEventListener(observation["listener"], event_type), None)
                    observation["loop"].quit()
                response = {"id": request.get("id"), "ok": True, "source": "linux-atspi-service"}
            else:
                raise ValueError("Unsupported observer command")
        except Exception as exc:
            response = {"id": request.get("id"), "ok": False, "error": str(exc)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def perform_action(request):
    path = decode_id(request.get("elementId", ""))
    obj = resolve_path(path)
    desktop = pyatspi.Registry.getDesktop(0)
    target_application = child_at(desktop, path[0]) if path else None
    target_application_name = str(safe(lambda: target_application.name, "") or "")
    external_observer = bool(request.get("eventObserverActive"))
    settle_observation = None if external_observer else begin_atspi_settle(target_application_name)
    def action_settle():
        if external_observer:
            return {"settleDurationMs": 0, "settleEventCount": 0, "settleSource": "external-observer-pending"}
        return finish_atspi_settle(settle_observation)
    action = str(request.get("action", ""))
    value = str(request.get("value", "") or "")
    names, action_iface = action_names(obj)
    component = safe(lambda: obj.queryComponent(), None)

    if action.startswith("native:"):
        requested = action[7:]
        if action_iface is None or requested not in names:
            raise RuntimeError(f"AT-SPI action is no longer available: {requested}")
        if not action_iface.doAction(names.index(requested)):
            raise RuntimeError("AT-SPI native action returned false")
        return {"ok": True, "source": "linux-atspi", "action": action, **action_settle()}

    if action == "click":
        bounds = bounds_info(obj)
        if not bounds or bounds["width"] <= 0 or bounds["height"] <= 0:
            raise RuntimeError("Element has no visible click bounds")
        x = bounds["x"] + bounds["width"] // 2
        y = bounds["y"] + bounds["height"] // 2
        button = {"left": 1, "middle": 2, "right": 3}.get(str(request.get("button", "left")), 1)
        count = max(1, min(int(request.get("count", 1) or 1), 3))
        event = f"b{button}d" if count == 2 else f"b{button}c"
        if count == 3:
            for _ in range(3):
                pyatspi.Registry.generateMouseEvent(x, y, f"b{button}c")
        else:
            pyatspi.Registry.generateMouseEvent(x, y, event)
    elif action in {"press", "toggle"}:
        index = choose_native_action(names)
        if action_iface is not None and index is not None:
            if not action_iface.doAction(index):
                raise RuntimeError("AT-SPI action returned false")
        else:
            bounds = bounds_info(obj)
            if not bounds or bounds["width"] <= 0 or bounds["height"] <= 0:
                raise RuntimeError("Element has no invokable action or visible bounds")
            x = bounds["x"] + bounds["width"] // 2
            y = bounds["y"] + bounds["height"] // 2
            pyatspi.Registry.generateMouseEvent(x, y, "b1c")
    elif action == "focus":
        if component is None or not component.grabFocus():
            raise RuntimeError("Element cannot receive focus")
    elif action == "scroll_into_view":
        if component is None:
            raise RuntimeError("Element has no component interface")
        scrolled = False
        if hasattr(component, "scrollTo"):
            scrolled = bool(safe(lambda: component.scrollTo(pyatspi.SCROLL_ANYWHERE), False))
        if not scrolled:
            component.grabFocus()
    elif action == "scroll":
        bounds = bounds_info(obj)
        if not bounds or bounds["width"] <= 0 or bounds["height"] <= 0:
            raise RuntimeError("Element has no visible scroll bounds")
        if not shutil.which("xdotool"):
            raise RuntimeError("xdotool is required for element-targeted scrolling")
        x = bounds["x"] + bounds["width"] // 2
        y = bounds["y"] + bounds["height"] // 2
        direction = str(request.get("direction", "down"))
        wheel = {"up": "4", "down": "5", "left": "6", "right": "7"}.get(direction, "5")
        pages = max(1, min(int(request.get("pages", 1) or 1), 100))
        subprocess.run(["xdotool", "mousemove", str(x), str(y), "click", "--repeat", str(pages * 5), wheel], check=True, timeout=10)
    elif action == "set_value":
        editable = safe(lambda: obj.queryEditableText(), None)
        if editable is None:
            raise RuntimeError("Element is not editable")
        editable.setTextContents(value)
    elif action == "select_text":
        needle = str(request.get("text", "") or "")
        if not needle:
            raise RuntimeError("select_text requires non-empty text")
        text_iface = safe(lambda: obj.queryText(), None)
        if text_iface is None:
            raise RuntimeError("Element has no text interface")
        count = int(safe(lambda: text_iface.characterCount, 0) or 0)
        source = str(safe(lambda: text_iface.getText(0, count), "") or "")
        prefix = str(request.get("prefix", "") or "")
        suffix = str(request.get("suffix", "") or "")
        start = -1
        cursor = 0
        while cursor <= len(source):
            found = source.find(needle, cursor)
            if found < 0:
                break
            if (not prefix or source[:found].endswith(prefix)) and (not suffix or source[found + len(needle):].startswith(suffix)):
                start = found
                break
            cursor = found + max(1, len(needle))
        if start < 0:
            raise RuntimeError("Text was not found in the AT-SPI element")
        end = start + len(needle)
        selection_type = str(request.get("selectionType", "text"))
        if selection_type == "cursor_before":
            end = start
        elif selection_type == "cursor_after":
            start = end
        selections = int(safe(lambda: text_iface.getNSelections(), 0) or 0)
        changed = safe(lambda: text_iface.setSelection(0, start, end), False) if selections else safe(lambda: text_iface.addSelection(start, end), False)
        if not changed:
            raise RuntimeError("AT-SPI element did not accept the requested text selection")
    elif action in {"increment", "decrement"}:
        iface = safe(lambda: obj.queryValue(), None)
        if iface is None:
            raise RuntimeError("Element has no numeric value interface")
        increment = safe(lambda: float(iface.minimumIncrement), 1.0) or 1.0
        current = float(iface.currentValue)
        iface.currentValue = current + (increment if action == "increment" else -increment)
    else:
        raise RuntimeError(f"Unsupported AT-SPI action: {action}")

    return {"ok": True, "source": "linux-atspi", "action": action, **action_settle()}


def list_applications():
    usage = {}
    usage_path = os.path.join(os.path.expanduser("~"), ".local", "share", "gnome-shell", "application_state")
    try:
        with open(usage_path, "r", encoding="utf-8") as stream:
            raw_usage = json.load(stream)
        records = raw_usage.get("applications", raw_usage) if isinstance(raw_usage, dict) else {}
        for key, value in records.items():
            if not isinstance(value, dict):
                continue
            seen = value.get("last_seen", value.get("lastUsed"))
            if isinstance(seen, (int, float)) and seen > 0:
                seconds = seen / 1000.0 if seen > 10_000_000_000 else seen
                last_used = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
            else:
                last_used = None
            count = value.get("count", value.get("use_count"))
            usage[str(key).lower()] = {"lastUsedDate": last_used, "useCount": int(count) if isinstance(count, (int, float)) and count >= 0 else None}
    except Exception:
        pass
    desktop = pyatspi.Registry.getDesktop(0)
    by_id = {}
    count = int(safe(lambda: desktop.childCount, 0) or 0)
    for index in range(min(count, 100)):
        app = child_at(desktop, index)
        name = str(safe(lambda: app.name, "") or "").strip()
        if not name:
            continue
        app_id = f"atspi:{name.lower()}"
        by_id[app_id] = {"id": app_id, "displayName": name, "path": "", "isRunning": True, "pid": None, "lastUsedDate": None, "useCount": None}

    for entry in desktop_application_entries():
        app_id = entry["id"]
        running_match = next((item for item in by_id.values() if item["displayName"].lower() == entry["displayName"].lower()), None)
        by_id[app_id] = {
            "id": app_id, "displayName": entry["displayName"], "path": entry["path"],
            "isRunning": bool(running_match), "pid": None,
            **usage.get(entry["desktopId"].lower(), usage.get((entry["desktopId"] + ".desktop").lower(), {"lastUsedDate": None, "useCount": None})),
        }
    return sorted(by_id.values(), key=lambda item: (not item["isRunning"], -(item.get("useCount") or -1), item.get("lastUsedDate") or "", item["displayName"].lower()))


def activate_application(request):
    guard = session_guard()
    if not guard["interactiveDesktop"]:
        raise RuntimeError("The Linux desktop session is locked or inactive; unlock the active session before activating an application")
    requested = str(request.get("application", "") or "").strip()
    if not requested:
        raise RuntimeError("application is required")
    requested_lower = requested.lower()
    desktop_id = requested[8:] if requested_lower.startswith("desktop:") else ""
    entry = next((item for item in desktop_application_entries() if item["desktopId"].lower() == desktop_id.lower()), None) if desktop_id else None
    display_name = entry["displayName"] if entry else (requested[6:] if requested_lower.startswith("atspi:") else requested)

    def matching_app():
        desktop = pyatspi.Registry.getDesktop(0)
        count = int(safe(lambda: desktop.childCount, 0) or 0)
        for index in range(min(count, 100)):
            app = child_at(desktop, index)
            name = str(safe(lambda: app.name, "") or "").strip()
            if name and (name.lower() == display_name.lower() or display_name.lower() in name.lower()):
                return app, name
        return None, ""

    app, matched_name = matching_app()
    launched = False
    if app is None and desktop_id:
        launcher = shutil.which("gtk-launch")
        if not launcher:
            raise RuntimeError("gtk-launch is required to start a desktop application")
        subprocess.Popen([launcher, desktop_id], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        launched = True
        for _ in range(40):
            time.sleep(0.1)
            app, matched_name = matching_app()
            if app is not None:
                break
    if app is None:
        raise RuntimeError(f"Linux application is not running and cannot be launched by this identifier: {requested}")

    xdotool = shutil.which("xdotool")
    if xdotool:
        candidate_window_ids = []
        seen_window_ids = set()

        def add_window_id(window_id):
            window_id = str(window_id or "").strip()
            if window_id and window_id not in seen_window_ids:
                seen_window_ids.add(window_id)
                candidate_window_ids.append(window_id)

        found = subprocess.run(
            [xdotool, "search", "--onlyvisible", "--name", re.escape(matched_name or display_name)],
            capture_output=True, text=True, timeout=4, check=False,
        )
        for line in found.stdout.splitlines():
            add_window_id(line)

        # AT-SPI application names are not guaranteed to equal X11 window
        # titles. For example, an application exposed as
        # "chatgpt-computer-semantic-test" may own a window titled
        # "ChatGPT Computer Semantic Test". Fall back to the visible-window
        # list and compare normalized titles so activation remains pinned to
        # the same observed application instead of clicking an arbitrary
        # foreground window.
        wmctrl = shutil.which("wmctrl")
        expected_title = re.sub(r"[^a-z0-9]+", "", (matched_name or display_name).lower())
        if wmctrl and expected_title:
            listed = subprocess.run([wmctrl, "-l"], capture_output=True, text=True, timeout=4, check=False)
            for line in listed.stdout.splitlines():
                parts = line.split(None, 3)
                if len(parts) < 4:
                    continue
                actual_title = re.sub(r"[^a-z0-9]+", "", parts[3].lower())
                if not actual_title:
                    continue
                if actual_title == expected_title or expected_title in actual_title or actual_title in expected_title:
                    try:
                        add_window_id(str(int(parts[0], 16)))
                    except ValueError:
                        add_window_id(parts[0])

        for window_id in candidate_window_ids:
            activated = subprocess.run([xdotool, "windowactivate", "--sync", window_id], timeout=5, check=False)
            if activated.returncode == 0:
                return {"ok": True, "source": "linux-atspi", "application": matched_name, "applicationId": requested, "launched": launched}

    def focus_first_window(obj, depth=0):
        if obj is None or depth > 4:
            return False
        role = canonical_role(safe(lambda: obj.getRoleName(), ""))
        component = safe(lambda: obj.queryComponent(), None)
        if role in {"frame", "window", "dialog"} and component is not None and safe(lambda: component.grabFocus(), False):
            return True
        count = int(safe(lambda: obj.childCount, 0) or 0)
        return any(focus_first_window(child_at(obj, index), depth + 1) for index in range(min(count, 100)))

    if not focus_first_window(app):
        raise RuntimeError(f"Linux application was found but could not be activated: {matched_name or display_name}")
    return {"ok": True, "source": "linux-atspi", "application": matched_name, "applicationId": requested, "launched": launched}


def main():
    request = json.loads(sys.stdin.read() or "{}")
    mode = request.get("mode", "list")
    if mode == "doctor":
        desktop = pyatspi.Registry.getDesktop(0)
        emit({"ok": True, "source": "linux-atspi", "applications": int(safe(lambda: desktop.childCount, 0) or 0), "permissions": session_guard()})
    elif mode == "list":
        emit(list_elements(request))
    elif mode == "applications":
        emit({"ok": True, "source": "linux-atspi", "applications": list_applications()})
    elif mode == "activate":
        emit(activate_application(request))
    elif mode == "action":
        guard = session_guard()
        if not guard["interactiveDesktop"]:
            raise RuntimeError("The Linux desktop session is locked or inactive; unlock the active session before sending computer input")
        emit(perform_action(request))
    else:
        raise ValueError(f"Unsupported mode: {mode}")


try:
    if "--observer-server" in sys.argv:
        observer_server()
    else:
        main()
except Exception as exc:
    emit({"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=3)})
