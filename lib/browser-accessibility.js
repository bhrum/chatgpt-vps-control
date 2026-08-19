import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const DEFAULT_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230];
const DEFAULT_TIMEOUT_MS = 10_000;
const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "dialog", "gridcell", "link", "listbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "radio", "scrollbar", "searchbox", "slider",
  "spinbutton", "switch", "tab", "textbox", "treeitem",
]);
const EDITABLE_ROLES = new Set(["combobox", "searchbox", "spinbutton", "textbox"]);

export class CdpClient {
  constructor(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.socket = null;
    this.connecting = null;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.socket = new WebSocket(this.url, { perMessageDeflate: false });
    this.connecting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connection timed out: ${this.url}`)), this.timeoutMs);
      this.socket.once("open", () => { clearTimeout(timer); resolve(); });
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    }).finally(() => { this.connecting = null; });
    await this.connecting;
    this.socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!message.id) {
        for (const handler of this.eventHandlers.get(String(message.method ?? "")) ?? []) {
          try { handler(message.params ?? {}); } catch {}
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
    this.socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP socket closed."));
      }
      this.pending.clear();
    });
  }

  on(method, handler) {
    const key = String(method);
    const handlers = this.eventHandlers.get(key) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(key, handlers);
    return () => handlers.delete(handler);
  }

  async send(method, params = {}) {
    return this.sendSession("", method, params);
  }

  async sendSession(sessionId, method, params = {}) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId: String(sessionId) } : {}) }));
    });
  }

  close() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close();
    this.socket = null;
    this.connecting = null;
  }
}

function boundedString(value, max = 1000) {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function valueOf(attribute) {
  if (!attribute || typeof attribute !== "object") return "";
  return boundedString(attribute.value ?? "");
}

function propertyMap(node) {
  const map = new Map();
  for (const property of node.properties ?? []) map.set(property.name, property.value?.value);
  return map;
}

function isInteresting(node, includeStaticText) {
  if (node.ignored) return false;
  const role = valueOf(node.role).toLowerCase();
  if (!role || ["none", "generic", "rootwebarea", "webarea", "document"].includes(role)) return false;
  if (INTERACTIVE_ROLES.has(role)) return true;
  const props = propertyMap(node);
  if (props.get("focusable") === true || props.get("editable") === true) return true;
  return includeStaticText && ["heading", "img", "paragraph", "statictext", "status"].includes(role);
}

function encodeElementId(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeElementId(id) {
  let payload;
  try { payload = JSON.parse(Buffer.from(String(id), "base64url").toString("utf8")); }
  catch { throw new Error("Invalid browser element id."); }
  if (payload?.source !== "browser-cdp" || !payload.endpoint || !payload.targetId || !payload.backendNodeId || typeof payload.targetTitle !== "string" || typeof payload.targetUrl !== "string") {
    throw new Error("Invalid browser element id.");
  }
  return payload;
}

function browserSessionRoot() {
  return process.env.COMPUTER_BROWSER_SESSION_DIR || join(homedir(), ".chatgpt-computer-control", "browser-sessions");
}

async function managedEndpointCandidates() {
  let entries;
  try { entries = await readdir(browserSessionRoot(), { withFileTypes: true }); }
  catch { return []; }
  const endpoints = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const content = await readFile(join(browserSessionRoot(), entry.name, "profile", "DevToolsActivePort"), "utf8");
      const lines = String(content).split(/\r?\n/);
      const port = Number(lines[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const endpoint = `http://127.0.0.1:${port}`;
      const browserPath = String(lines[1] ?? "").trim();
      if (browserPath) {
        const version = await fetchJson(`${endpoint}/json/version`, 800);
        if (new URL(String(version?.webSocketDebuggerUrl ?? "")).pathname !== browserPath) continue;
      }
      endpoints.push(endpoint);
    } catch {
      // Stopped or incomplete managed sessions do not have a live DevToolsActivePort file.
    }
  }
  return endpoints;
}

async function endpointCandidates() {
  const configured = String(process.env.COMPUTER_CDP_ENDPOINTS ?? process.env.COMPUTER_CDP_URL ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/\/$/, ""));
  const ports = String(process.env.COMPUTER_CDP_PORTS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
  const selectedPorts = ports.length ? ports : DEFAULT_PORTS;
  const managed = await managedEndpointCandidates();
  return [...new Set([
    ...configured,
    ...managed,
    ...selectedPorts.map((port) => `http://127.0.0.1:${port}`),
  ])];
}

async function fetchJson(url, timeoutMs = 1200, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOk(url, timeoutMs = 1200, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverBrowserTargets() {
  const endpoints = await endpointCandidates();
  const batches = await Promise.all(endpoints.map(async (endpoint) => {
    try {
      const items = await fetchJson(`${endpoint}/json/list`);
      return items
        .filter((item) => item.type === "page" && item.webSocketDebuggerUrl)
        .map((item) => ({
          source: "browser-cdp",
          endpoint,
          id: String(item.id),
          title: boundedString(item.title, 500),
          url: boundedString(item.url, 2000),
          webSocketDebuggerUrl: item.webSocketDebuggerUrl,
        }));
    } catch {
      // CDP is optional; probe all endpoints concurrently so closed default ports do not add serial latency.
      return [];
    }
  }));
  return batches.flat();
}

function selectTarget(targets, { targetId, title, url } = {}) {
  if (!targets.length) throw new Error("No Chrome/Electron CDP page target is available. Start the app with a loopback remote-debugging port or configure COMPUTER_CDP_ENDPOINTS.");
  if (targetId) {
    const target = targets.find((item) => item.id === targetId);
    if (!target) throw new Error(`Browser target ${targetId} is no longer available.`);
    return target;
  }
  if (title) {
    const needle = String(title).toLowerCase();
    const target = targets.find((item) => item.title.toLowerCase().includes(needle));
    if (target) return target;
  }
  if (url) {
    const needle = String(url).toLowerCase();
    const target = targets.find((item) => item.url.toLowerCase().includes(needle));
    if (target) return target;
  }
  return targets.find((item) => !item.url.startsWith("chrome://")) ?? targets[0];
}

async function waitForDocumentReady(client, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const { result } = await client.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (["interactive", "complete"].includes(result?.value)) return;
    } catch {
      // The target may still be attaching; retry briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForBrowserUiSettle(client, timeoutMs = 5000) {
  const started = Date.now();
  let previous = "";
  let stableRounds = 0;
  while (Date.now() - started < timeoutMs) {
    let sample;
    try {
      const { result } = await client.send("Runtime.evaluate", {
        expression: `(() => {
          const body = document.body;
          return {
            fingerprint: JSON.stringify([
              location.href, document.readyState, window.scrollX, window.scrollY,
              body?.childElementCount || 0, (body?.innerText || '').slice(0, 20000)
            ]),
            busy: Boolean(document.querySelector('[aria-busy="true"], progress:not([value])'))
          };
        })()`,
        returnByValue: true,
      });
      sample = result?.value;
    } catch {
      sample = null;
    }
    if (sample?.fingerprint) {
      stableRounds = sample.fingerprint === previous ? stableRounds + 1 : 0;
      previous = sample.fingerprint;
      if (Date.now() - started >= 600 && stableRounds >= 1 && !sample.busy) return Date.now() - started;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return Date.now() - started;
}

async function targetMetrics(client) {
  try {
    const { result } = await client.send("Runtime.evaluate", {
      expression: `({screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio || 1})`,
      returnByValue: true,
    });
    return result?.value ?? null;
  } catch {
    return null;
  }
}

function quadBounds(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { x: Math.round(left), y: Math.round(top), width: Math.max(0, Math.round(right - left)), height: Math.max(0, Math.round(bottom - top)) };
}

async function boxForNode(client, backendNodeId, metrics) {
  try {
    const result = await client.send("DOM.getBoxModel", { backendNodeId });
    const viewport = quadBounds(result.model?.border ?? result.model?.content);
    if (!viewport) return { viewport: null, screen: null };
    if (!metrics) return { viewport, screen: null };
    const borderX = Math.max(0, (Number(metrics.outerWidth) - Number(metrics.innerWidth)) / 2);
    const toolbarY = Math.max(0, Number(metrics.outerHeight) - Number(metrics.innerHeight) - borderX);
    const dpr = Number(metrics.dpr) || 1;
    const screen = {
      x: Math.round((Number(metrics.screenX) + borderX + viewport.x) * dpr),
      y: Math.round((Number(metrics.screenY) + toolbarY + viewport.y) * dpr),
      width: Math.round(viewport.width * dpr),
      height: Math.round(viewport.height * dpr),
    };
    return { viewport, screen };
  } catch {
    return { viewport: null, screen: null };
  }
}

async function domMetadata(client, backendNodeId) {
  try {
    const { node } = await client.send("DOM.describeNode", { backendNodeId, depth: 0, pierce: true });
    const attributes = new Map();
    for (let index = 0; index < (node?.attributes ?? []).length; index += 2) {
      attributes.set(String(node.attributes[index]).toLowerCase(), String(node.attributes[index + 1] ?? ""));
    }
    return {
      subrole: boundedString(node?.nodeName ?? "", 200).toLowerCase(),
      identifier: boundedString(attributes.get("id") ?? attributes.get("data-testid") ?? attributes.get("name") ?? "", 500),
      placeholder: boundedString(attributes.get("placeholder") ?? "", 1000),
      url: boundedString(attributes.get("href") ?? attributes.get("src") ?? "", 4000),
    };
  } catch {
    return { subrole: "", identifier: "", placeholder: "", url: "" };
  }
}

function actionsForNode(role, props) {
  const actions = ["click", "scroll_into_view", "scroll"];
  if (INTERACTIVE_ROLES.has(role)) actions.push("press", "click");
  if (props.get("focusable") === true || EDITABLE_ROLES.has(role)) actions.push("focus");
  if (props.get("editable") === true || EDITABLE_ROLES.has(role)) actions.push("set_value", "select_text");
  if (["checkbox", "radio", "switch"].includes(role)) actions.push("toggle");
  if (["slider", "spinbutton"].includes(role)) actions.push("increment", "decrement");
  return [...new Set(actions)];
}

export async function listBrowserElements(options = {}) {
  const targets = await discoverBrowserTargets();
  const target = selectTarget(targets, options);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  const maxElements = Math.max(1, Math.min(Number(options.maxElements ?? 120), 500));
  const includeStaticText = Boolean(options.includeStaticText);
  const roleFilter = String(options.role ?? "").trim().toLowerCase();
  const nameFilter = String(options.name ?? options.query ?? "").trim().toLowerCase();
  try {
    await Promise.all([client.send("Accessibility.enable"), client.send("DOM.enable"), client.send("Page.enable").catch(() => ({}))]);
    await waitForDocumentReady(client);
    const [{ nodes = [] }, metrics] = await Promise.all([
      client.send("Accessibility.getFullAXTree"),
      targetMetrics(client),
    ]);
    const candidates = nodes.filter((node) => {
      if (!isInteresting(node, includeStaticText)) return false;
      const role = valueOf(node.role).toLowerCase();
      const name = `${valueOf(node.name)} ${valueOf(node.description)} ${valueOf(node.value)}`.toLowerCase();
      if (roleFilter && role !== roleFilter) return false;
      if (nameFilter && !name.includes(nameFilter)) return false;
      return Number.isInteger(node.backendDOMNodeId) && node.backendDOMNodeId > 0;
    }).slice(0, maxElements);

    const byNodeId = new Map(nodes.map((node) => [String(node.nodeId), node]));
    const depthOf = (node) => {
      let depth = 0;
      let cursor = node;
      const visited = new Set();
      while (cursor?.parentId && !visited.has(String(cursor.parentId)) && depth < 50) {
        visited.add(String(cursor.parentId));
        cursor = byNodeId.get(String(cursor.parentId));
        depth += 1;
      }
      return depth;
    };
    const elements = [];
    for (const node of candidates) {
      const role = valueOf(node.role).toLowerCase();
      const props = propertyMap(node);
      const bounds = await boxForNode(client, node.backendDOMNodeId, metrics);
      const metadata = await domMetadata(client, node.backendDOMNodeId);
      elements.push({
        id: encodeElementId({
          source: "browser-cdp", endpoint: target.endpoint, targetId: target.id,
          targetTitle: target.title, targetUrl: target.url, backendNodeId: node.backendDOMNodeId,
        }),
        role,
        name: valueOf(node.name),
        value: valueOf(node.value),
        description: valueOf(node.description),
        enabled: props.get("disabled") !== true,
        focused: props.get("focused") === true,
        selected: props.get("selected") === true,
        checked: props.has("checked") ? Boolean(props.get("checked")) : null,
        expanded: props.has("expanded") ? Boolean(props.get("expanded")) : null,
        bounds: bounds.screen,
        viewportBounds: bounds.viewport,
        actions: actionsForNode(role, props),
        nativeActions: [],
        subrole: metadata.subrole,
        identifier: metadata.identifier,
        placeholder: metadata.placeholder || boundedString(props.get("placeholder") ?? "", 1000),
        url: metadata.url || boundedString(props.get("url") ?? "", 4000),
        depth: depthOf(node),
      });
    }
    return {
      source: "browser-cdp",
      target: { id: target.id, title: target.title, url: target.url, endpoint: target.endpoint },
      targets: targets.map(({ id, title, url, endpoint }) => ({ id, title, url, endpoint })),
      elements,
      message: `Returned ${elements.length} accessibility elements from ${target.title || target.url}.`,
    };
  } finally {
    client.close();
  }
}

async function resolveTargetFromElement(payload) {
  const items = await fetchJson(`${payload.endpoint}/json/list`, 2000);
  const item = items.find((candidate) => String(candidate.id) === String(payload.targetId));
  if (!item?.webSocketDebuggerUrl) throw new Error("The browser element snapshot is stale because its page target is gone.");
  if (String(item.title ?? "") !== payload.targetTitle || String(item.url ?? "") !== payload.targetUrl) {
    throw new Error("The browser element snapshot is stale because its page title or URL changed. Refresh computer_elements before acting.");
  }
  return item;
}

async function callOnNode(client, backendNodeId, functionDeclaration, args = []) {
  const resolved = await client.send("DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("The browser element is no longer attached to the document.");
  const result = await client.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser element action failed.");
  return result.result?.value;
}

async function captureTargetScreenshot(client) {
  try {
    await client.send("Page.enable").catch(() => ({}));
    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return result?.data ? { data: String(result.data), mimeType: "image/png" } : null;
  } catch {
    return null;
  }
}

function publicTarget(target) {
  return {
    id: String(target.id),
    title: boundedString(target.title, 500),
    url: boundedString(target.url, 2000),
    endpoint: String(target.endpoint).replace(/\/$/, ""),
  };
}

async function refreshedTarget(target) {
  return (await discoverBrowserTargets()).find((item) => item.id === target.id && item.endpoint === target.endpoint) ?? target;
}

async function targetForCommand({ endpoint = "", targetId = "", title = "", matchUrl = "" } = {}) {
  const normalizedEndpoint = endpoint ? String(endpoint).replace(/\/$/, "") : "";
  const targets = await discoverBrowserTargets();
  const scopedTargets = normalizedEndpoint ? targets.filter((item) => item.endpoint === normalizedEndpoint) : targets;
  return selectTarget(scopedTargets, { targetId, title, url: matchUrl });
}

export async function createBrowserTarget({ endpoint, url = "about:blank" }) {
  const normalizedEndpoint = String(endpoint ?? "").replace(/\/$/, "");
  if (!normalizedEndpoint) throw new Error("endpoint is required.");
  const item = await fetchJson(`${normalizedEndpoint}/json/new?${encodeURIComponent(String(url))}`, 3000, { method: "PUT" });
  if (!item?.id || !item?.webSocketDebuggerUrl) throw new Error("Chrome did not create a controllable page target.");
  const target = {
    ...item,
    endpoint: normalizedEndpoint,
    id: String(item.id),
    title: boundedString(item.title, 500),
    url: boundedString(item.url, 2000),
  };
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await waitForDocumentReady(client, 10_000);
    return { target: publicTarget(await refreshedTarget(target)), screenshot: await captureTargetScreenshot(client) };
  } finally {
    client.close();
  }
}

export async function activateBrowserTarget(options = {}) {
  const target = await targetForCommand(options);
  await fetchOk(`${target.endpoint}/json/activate/${encodeURIComponent(target.id)}`, 3000);
  return { target: publicTarget(await refreshedTarget(target)), screenshot: null };
}

export async function closeBrowserTarget(options = {}) {
  const target = await targetForCommand(options);
  await fetchOk(`${target.endpoint}/json/close/${encodeURIComponent(target.id)}`, 3000);
  return { target: publicTarget(target), screenshot: null };
}

export async function browserTargetCommand({ action, ...options }) {
  const target = await targetForCommand(options);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    if (action === "reload") {
      await client.send("Page.reload", { ignoreCache: false });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await waitForDocumentReady(client, 10_000);
    } else if (action === "back" || action === "forward") {
      const history = await client.send("Page.getNavigationHistory");
      const offset = action === "back" ? -1 : 1;
      const entry = history.entries?.[Number(history.currentIndex) + offset];
      if (!entry) throw new Error(`Browser target cannot navigate ${action}; there is no matching history entry.`);
      await client.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await waitForDocumentReady(client, 10_000);
    } else if (action !== "screenshot") {
      throw new Error(`Unsupported browser target action: ${action}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { target: publicTarget(await refreshedTarget(target)), screenshot: await captureTargetScreenshot(client) };
  } finally {
    client.close();
  }
}

export async function navigateBrowserTarget({ endpoint = "", targetId = "", title = "", matchUrl = "", navigateTo }) {
  if (!navigateTo) throw new Error("navigateTo is required.");
  const target = await targetForCommand({ endpoint, targetId, title, matchUrl });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    const result = await client.send("Page.navigate", { url: String(navigateTo) });
    if (result?.errorText) throw new Error(`Browser navigation failed: ${result.errorText}`);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await waitForDocumentReady(client, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const screenshot = await captureTargetScreenshot(client);
    const refreshed = await refreshedTarget(target);
    return {
      target: publicTarget(refreshed),
      screenshot,
    };
  } finally {
    client.close();
  }
}

export async function browserElementAction({
  elementId,
  action,
  value = "",
  text = "",
  prefix = "",
  suffix = "",
  selectionType = "text",
  button = "left",
  count = 1,
  direction = "down",
  pages = 1,
}) {
  const payload = decodeElementId(elementId);
  const target = await resolveTargetFromElement(payload);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await Promise.all([client.send("DOM.enable"), client.send("Page.enable").catch(() => ({}))]);
    switch (action) {
      case "click": {
        await callOnNode(client, payload.backendNodeId, `function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); this.focus?.(); return true; }`);
        const model = await client.send("DOM.getBoxModel", { backendNodeId: payload.backendNodeId });
        const bounds = quadBounds(model.model?.border ?? model.model?.content);
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error("Browser element has no visible click bounds.");
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        const mouseButton = ["left", "right", "middle"].includes(button) ? button : "left";
        const clickCount = Math.max(1, Math.min(Number(count) || 1, 3));
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: mouseButton, clickCount });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: mouseButton, clickCount });
        break;
      }
      case "press":
      case "toggle":
        await callOnNode(client, payload.backendNodeId, `function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus?.(); if (typeof this.click === 'function') this.click(); else this.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return true; }`);
        break;
      case "focus":
        await client.send("DOM.focus", { backendNodeId: payload.backendNodeId });
        break;
      case "scroll_into_view":
        await callOnNode(client, payload.backendNodeId, `function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); return true; }`);
        break;
      case "scroll": {
        await callOnNode(client, payload.backendNodeId, `function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); return true; }`);
        const [model, metrics] = await Promise.all([
          client.send("DOM.getBoxModel", { backendNodeId: payload.backendNodeId }),
          targetMetrics(client),
        ]);
        const bounds = quadBounds(model.model?.border ?? model.model?.content);
        if (!bounds) throw new Error("Browser element has no visible scroll bounds.");
        const amount = Math.max(1, Math.min(Number(pages) || 1, 100)) * Math.max(240, Math.round(Number(metrics?.innerHeight) * 0.8) || 640);
        const horizontal = ["left", "right"].includes(direction);
        const sign = ["up", "left"].includes(direction) ? -1 : 1;
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          deltaX: horizontal ? sign * amount : 0,
          deltaY: horizontal ? 0 : sign * amount,
        });
        break;
      }
      case "set_value":
        if (await callOnNode(client, payload.backendNodeId, `function(next){
          this.scrollIntoView({block:'center',inline:'center'}); this.focus?.();
          if (this.isContentEditable) this.textContent = next;
          else if ('value' in this) {
            let proto = this; let setter = null;
            while (proto && !setter) { const d = Object.getOwnPropertyDescriptor(proto, 'value'); setter = d?.set; proto = Object.getPrototypeOf(proto); }
            if (setter) setter.call(this, next); else this.value = next;
          } else return false;
          this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:next}));
          this.dispatchEvent(new Event('change',{bubbles:true}));
          return true;
        }`, [String(value)]) !== true) throw new Error("Element does not accept a value.");
        break;
      case "select_text":
        if (!text) throw new Error("select_text requires non-empty text.");
        if (await callOnNode(client, payload.backendNodeId, `function(needle,prefix,suffix,selectionType){
          this.scrollIntoView({block:'center',inline:'center'}); this.focus?.();
          const source = ('value' in this ? String(this.value) : String(this.textContent || ''));
          let start = -1, cursor = 0;
          while (cursor <= source.length) {
            const found = source.indexOf(needle, cursor); if (found < 0) break;
            const before = source.slice(0, found), after = source.slice(found + needle.length);
            if ((!prefix || before.endsWith(prefix)) && (!suffix || after.startsWith(suffix))) { start = found; break; }
            cursor = found + Math.max(1, needle.length);
          }
          if (start < 0) return false;
          let from = start, to = start + needle.length;
          if (selectionType === 'cursor_before') to = from;
          else if (selectionType === 'cursor_after') from = to;
          if (typeof this.setSelectionRange === 'function') { this.setSelectionRange(from, to); return true; }
          if (!this.isContentEditable) return false;
          const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT); let offset = 0, startNode, endNode, startOffset = 0, endOffset = 0;
          while (walker.nextNode()) { const node = walker.currentNode, next = offset + node.data.length;
            if (!startNode && from >= offset && from <= next) { startNode = node; startOffset = from - offset; }
            if (!endNode && to >= offset && to <= next) { endNode = node; endOffset = to - offset; break; }
            offset = next;
          }
          if (!startNode || !endNode) return false;
          const range = document.createRange(); range.setStart(startNode,startOffset); range.setEnd(endNode,endOffset);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true;
        }`, [String(text), String(prefix), String(suffix), String(selectionType)]) !== true) {
          throw new Error("Text was not found or the browser element does not support text selection.");
        }
        break;
      case "increment":
      case "decrement":
        if (await callOnNode(client, payload.backendNodeId, `function(direction){
          this.focus?.();
          if (direction === 'increment' && typeof this.stepUp === 'function') this.stepUp();
          else if (direction === 'decrement' && typeof this.stepDown === 'function') this.stepDown();
          else {
            const delta = direction === 'increment' ? 1 : -1;
            const current = Number(this.value || this.getAttribute?.('aria-valuenow') || 0);
            if ('value' in this) this.value = String(current + delta);
            else this.setAttribute?.('aria-valuenow', String(current + delta));
          }
          this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return true;
        }`, [action]) !== true) throw new Error("Element range action failed.");
        break;
      default:
        throw new Error(`Unsupported browser element action: ${action}`);
    }
    await waitForDocumentReady(client, 5000);
    const settleDurationMs = await waitForBrowserUiSettle(client, 5000);
    const screenshot = await captureTargetScreenshot(client);
    return { ok: true, source: "browser-cdp", action, targetId: payload.targetId, screenshot, settleDurationMs, settleEventCount: 0, settleSource: "browser-dom-fingerprint" };
  } finally {
    client.close();
  }
}
