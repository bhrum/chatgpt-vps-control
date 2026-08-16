#!/usr/bin/env python3
import base64
import json
import os
import sys
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
        actions.append("press")
    if safe(lambda: obj.queryComponent(), None) is not None:
        actions.extend(["focus", "scroll_into_view"])
    if editable:
        actions.append("set_value")
    if role in {"check box", "radio button", "toggle button"}:
        actions.append("toggle")
    if has_value:
        actions.extend(["increment", "decrement"])
    return list(dict.fromkeys(actions))


def element_info(obj, path):
    role = canonical_role(safe(lambda: obj.getRoleName(), "unknown"))
    native_actions, _ = action_names(obj)
    value, editable = text_value(obj)
    numeric = value_info(obj)
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
    }


def interesting(obj, include_static):
    role = canonical_role(safe(lambda: obj.getRoleName(), ""))
    if role in INTERACTIVE_ROLES:
        return True
    if state_has(obj, pyatspi.STATE_FOCUSABLE):
        return True
    if include_static and role in STATIC_ROLES:
        return True
    return False


def list_elements(request):
    desktop = pyatspi.Registry.getDesktop(0)
    max_elements = max(1, min(int(request.get("maxElements", 120)), 500))
    include_static = bool(request.get("includeStaticText", False))
    role_filter = canonical_role(request.get("role", "")) if request.get("role", "") else ""
    query = str(request.get("query", request.get("name", "")) or "").strip().lower()
    application = str(request.get("application", "") or "").strip().lower()
    result = []

    def walk(obj, path, depth):
        if obj is None or depth > MAX_DEPTH or len(result) >= max_elements:
            return
        if depth > 0 and interesting(obj, include_static):
            info = element_info(obj, path)
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
        if application and application not in app_name.lower():
            continue
        walk(app, [app_index], 0)

    return {
        "ok": True,
        "source": "linux-atspi",
        "applications": applications,
        "elements": result,
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


def perform_action(request):
    obj = resolve_path(decode_id(request.get("elementId", "")))
    action = str(request.get("action", ""))
    value = str(request.get("value", "") or "")
    names, action_iface = action_names(obj)
    component = safe(lambda: obj.queryComponent(), None)

    if action in {"press", "toggle"}:
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
    elif action == "set_value":
        editable = safe(lambda: obj.queryEditableText(), None)
        if editable is None:
            raise RuntimeError("Element is not editable")
        editable.setTextContents(value)
    elif action in {"increment", "decrement"}:
        iface = safe(lambda: obj.queryValue(), None)
        if iface is None:
            raise RuntimeError("Element has no numeric value interface")
        increment = safe(lambda: float(iface.minimumIncrement), 1.0) or 1.0
        current = float(iface.currentValue)
        iface.currentValue = current + (increment if action == "increment" else -increment)
    else:
        raise RuntimeError(f"Unsupported AT-SPI action: {action}")

    return {"ok": True, "source": "linux-atspi", "action": action}


def main():
    request = json.loads(sys.stdin.read() or "{}")
    mode = request.get("mode", "list")
    if mode == "doctor":
        desktop = pyatspi.Registry.getDesktop(0)
        emit({"ok": True, "source": "linux-atspi", "applications": int(safe(lambda: desktop.childCount, 0) or 0)})
    elif mode == "list":
        emit(list_elements(request))
    elif mode == "action":
        emit(perform_action(request))
    else:
        raise ValueError(f"Unsupported mode: {mode}")


try:
    main()
except Exception as exc:
    emit({"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=3)})
