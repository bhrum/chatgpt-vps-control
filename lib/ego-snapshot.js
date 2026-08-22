// Compact accessibility snapshots inspired by the MIT-licensed ego-lite
// interaction model. This implementation is native to this project and keeps
// refs bound to server-side CDP node ids instead of exposing executable code.

const ACTIONABLE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem",
  "option", "radio", "searchbox", "slider", "spinbutton", "switch",
  "tab", "textbox", "treeitem",
]);
const QUIET_ROLES = new Set(["generic", "none", "presentation", "rootwebarea"]);

function axValue(value) {
  if (value && typeof value === "object" && "value" in value) return value.value;
  return value;
}
function clean(value, limit = 2_000) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function propertyMap(node) {
  return new Map((Array.isArray(node?.properties) ? node.properties : [])
    .map((property) => [String(property?.name ?? ""), axValue(property?.value)]));
}

function quoted(value) {
  return JSON.stringify(clean(value));
}

export function buildCompactAxSnapshot(nodes, { maxNodes = 500, includeText = true, maxChars = 200_000 } = {}) {
  const selected = [];
  const refs = [];
  const limit = Math.max(1, Math.min(Number(maxNodes) || 500, 1_000));
  let refIndex = 0;

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (selected.length >= limit) break;
    if (node?.ignored === true) continue;
    const role = clean(axValue(node?.role), 200).toLowerCase();
    const name = clean(axValue(node?.name));
    const value = clean(axValue(node?.value), 5_000);
    const actionable = ACTIONABLE_ROLES.has(role);
    const textRole = role === "statictext" || role === "inlinetextbox";
    if ((!includeText && textRole) || (!actionable && !name && !value) || (QUIET_ROLES.has(role) && !name)) continue;

    const properties = propertyMap(node);
    const backendNodeId = Number(node?.backendDOMNodeId);
    const canReference = Number.isInteger(backendNodeId) && backendNodeId > 0;
    const ref = canReference ? `@${++refIndex}` : null;
    const flags = [];
    if (properties.get("disabled") === true) flags.push("disabled");
    if (properties.has("checked")) flags.push(`checked=${String(properties.get("checked"))}`);
    if (properties.has("expanded")) flags.push(`expanded=${String(properties.get("expanded"))}`);
    if (properties.has("selected")) flags.push(`selected=${String(properties.get("selected"))}`);
    if (properties.has("level")) flags.push(`level=${String(properties.get("level"))}`);

    const parts = [ref, role || "node", name ? quoted(name) : "", value && value !== name ? `value=${quoted(value)}` : "", flags.length ? `[${flags.join(" ")}]` : ""].filter(Boolean);
    selected.push(parts.join(" "));
    if (ref) refs.push({ ref, backendNodeId, role: role || "node", name, value });
  }

  const content = selected.join("\n");
  return {
    content: content.length <= maxChars ? content : `${content.slice(0, Math.max(0, maxChars - 14))}\n… truncated`,
    refs,
    nodeCount: selected.length,
    truncated: selected.length >= limit || content.length > maxChars,
  };
}
