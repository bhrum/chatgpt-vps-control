import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, delimiter, isAbsolute, join, parse, relative, resolve } from "node:path";
import WebSocket from "ws";
import {
  CdpClient,
  activateBrowserTarget,
  browserTargetCommand,
  closeBrowserTarget,
  createBrowserTarget,
  navigateBrowserTarget,
} from "./browser-accessibility.js";
import {
  ExtensionCdpClient,
  browserExtensionRequest,
  listBrowserExtensionConnections,
  startBrowserExtensionBridge,
} from "./browser-extension-bridge.js";
import { buildCompactAxSnapshot } from "./ego-snapshot.js";

const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const START_TIMEOUT_MS = 15_000;
const HTTP_TIMEOUT_MS = 1_500;
const MAX_LOG_ENTRIES = 500;
const MAX_EXPORT_CHARS = 2_000_000;
const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_FILE_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_CUA_SCREENSHOT_DIMENSION = 50_000;
const MAX_CUA_SCREENSHOT_AREA = 100_000_000;
const TARGET_MONITORS = new Map();
const BROWSER_MONITORS = new Map();
const TAB_LIFECYCLES = new Map();
const BROWSER_REF_SNAPSHOTS = new Map();
const BROWSER_REF_TTL_MS = 90_000;
const MAX_BROWSER_REF_SNAPSHOTS = 32;

function sessionRoot() {
  return process.env.COMPUTER_BROWSER_SESSION_DIR || join(homedir(), ".chatgpt-computer-control", "browser-sessions");
}

function normalizeSessionName(value) {
  const name = String(value ?? "").trim();
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error("Browser session name must be 1-64 characters using letters, digits, dot, underscore, or hyphen, and must start with a letter or digit.");
  }
  return name;
}

function configuredAttachEndpoints() {
  return [...new Set(String(process.env.COMPUTER_CDP_ENDPOINTS ?? process.env.COMPUTER_CDP_URL ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter((value) => {
      if (!value) return false;
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol)
          && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
      } catch { return false; }
    }))];
}

function normalizeNavigationUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw === "about:blank") return raw;
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("Browser navigation URL must be an absolute http, https, data, or about:blank URL."); }
  const allowed = new Set(["http:", "https:", "data:"]);
  if (!allowed.has(parsed.protocol)) {
    throw new Error(`Browser navigation does not allow the ${parsed.protocol || "unknown"} URL scheme.`);
  }
  return parsed.href;
}

function pathsForSession(name) {
  const root = join(sessionRoot(), name);
  return {
    root,
    profile: join(root, "profile"),
    metadata: join(root, "session.json"),
    devtoolsPort: join(root, "profile", "DevToolsActivePort"),
    downloads: join(root, "downloads"),
    exports: join(root, "exports"),
  };
}

function pathWithin(root, candidate) {
  const offset = relative(root, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

export async function resolveBrowserUploadFiles(sessionName, values) {
  const name = normalizeSessionName(sessionName);
  const selected = Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [];
  if (selected.length > MAX_UPLOAD_FILES) throw new Error(`Browser file upload allows at most ${MAX_UPLOAD_FILES} files.`);
  const configuredRoots = String(process.env.COMPUTER_BROWSER_UPLOAD_ROOTS ?? "")
    .split(delimiter).map((value) => value.trim()).filter(Boolean).map((value) => resolve(value));
  const sessionDownloads = pathsForSession(name).downloads;
  const sessionExports = pathsForSession(name).exports;
  await Promise.all([mkdir(sessionDownloads, { recursive: true, mode: 0o700 }), mkdir(sessionExports, { recursive: true, mode: 0o700 })]);
  const roots = [];
  for (const candidate of [process.cwd(), sessionDownloads, sessionExports, ...configuredRoots]) {
    if (resolve(candidate) === parse(resolve(candidate)).root) continue;
    try { roots.push(await realpath(candidate)); } catch {}
  }
  const files = [];
  let totalBytes = 0;
  for (const requested of selected) {
    const path = await realpath(resolve(requested)).catch(() => null);
    if (!path) throw new Error(`Browser upload file does not exist: ${requested}`);
    if (!roots.some((root) => pathWithin(root, path))) {
      throw new Error(`Browser upload file is outside COMPUTER_BROWSER_UPLOAD_ROOTS, the workspace, and the session download/export directories: ${requested}`);
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Browser upload path is not a regular file: ${requested}`);
    if (info.size > MAX_UPLOAD_FILE_BYTES) throw new Error(`Browser upload file exceeds ${MAX_UPLOAD_FILE_BYTES} bytes: ${requested}`);
    totalBytes += info.size;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw new Error(`Browser upload selection exceeds ${MAX_UPLOAD_TOTAL_BYTES} bytes.`);
    files.push(path);
  }
  return files;
}

export function sanitizeBrowserPdfName(value) {
  const stem = String(value ?? "").trim().replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 160);
  return `${stem || `page-${new Date().toISOString().replace(/[:.]/g, "-")}`}.pdf`;
}

async function uniqueExportPath(directory, requestedName, temporary) {
  const name = sanitizeBrowserPdfName(requestedName);
  const stem = name.slice(0, -4);
  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index ? `${stem}-${index}.pdf` : name;
    const candidate = join(directory, candidateName);
    try {
      await link(temporary, candidate);
      return { name: candidateName, path: candidate };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique PDF export filename.");
}

function boundedText(value, maximum = 10_000) {
  const text = value == null ? "" : String(value);
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function publicDialog(params) {
  if (!params) return null;
  return {
    type: String(params.type ?? "alert"),
    message: boundedText(params.message, 20_000),
    defaultPrompt: boundedText(params.defaultPrompt, 20_000),
    url: boundedText(params.url, 4000),
  };
}

function pushLog(monitor, entry) {
  monitor.logs.push({
    level: String(entry.level ?? entry.type ?? "log"),
    text: boundedText(entry.text, 20_000),
    source: String(entry.source ?? "console"),
    timestamp: Number(entry.timestamp) || Date.now(),
    url: boundedText(entry.url, 4000),
    lineNumber: Number.isInteger(entry.lineNumber) ? entry.lineNumber : null,
  });
  if (monitor.logs.length > MAX_LOG_ENTRIES) monitor.logs.splice(0, monitor.logs.length - MAX_LOG_ENTRIES);
}

async function fetchJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

async function readDevToolsDescriptor(path) {
  try {
    const text = await readFile(path, "utf8");
    const lines = String(text).split(/\r?\n/);
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { endpoint: `http://127.0.0.1:${port}`, browserPath: String(lines[1] ?? "").trim() };
  } catch {
    return null;
  }
}

async function endpointIsAlive(endpoint, browserPath = "") {
  if (!endpoint) return false;
  try {
    const version = await fetchJson(`${endpoint}/json/version`);
    if (browserPath) {
      const livePath = new URL(String(version?.webSocketDebuggerUrl ?? "")).pathname;
      if (livePath !== browserPath) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function pathExecutableCandidates(names) {
  const pathEntries = String(process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return pathEntries.flatMap((entry) => names.map((name) => join(entry, name)));
}

async function resolveChromeExecutable() {
  const configured = String(process.env.COMPUTER_CHROME_EXECUTABLE ?? "").trim();
  const home = homedir();
  let candidates = configured ? [configured] : [];
  if (platform() === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(home, "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"),
    );
  } else if (platform() === "win32") {
    for (const root of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean)) {
      candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/opt/google/chrome/chrome",
      ...pathExecutableCandidates(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]),
    );
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw new Error("Google Chrome/Chromium executable was not found. Set COMPUTER_CHROME_EXECUTABLE to an explicit browser binary.");
}

function targetClaim(browserIdentity, target) {
  return createHash("sha256")
    .update(String(browserIdentity))
    .update("\0").update(String(target.id))
    .update("\0").update(String(target.title ?? ""))
    .update("\0").update(String(target.url ?? ""))
    .digest("base64url");
}

function tabLifecycleKey(sessionName, targetId) {
  return `${sessionName}:${targetId}`;
}

function tabLifecycle(sessionName, browserIdentity, targetId) {
  const entry = TAB_LIFECYCLES.get(tabLifecycleKey(sessionName, targetId));
  if (entry?.browserIdentity === browserIdentity) return { owner: "automation", retained: entry.retained === true };
  return { owner: "user", retained: true };
}

function recordTabLifecycle(sessionName, browserIdentity, targetId, retained) {
  TAB_LIFECYCLES.set(tabLifecycleKey(sessionName, targetId), { browserIdentity, retained: retained === true });
  while (TAB_LIFECYCLES.size > 500) TAB_LIFECYCLES.delete(TAB_LIFECYCLES.keys().next().value);
}

async function setTabLifecycle(session, targetId, retained) {
  const version = await fetchJson(`${session.endpoint}/json/version`, 2_000);
  const browserIdentity = new URL(String(version?.webSocketDebuggerUrl ?? "")).pathname;
  if (!browserIdentity) throw new Error(`Browser session ${session.name} has no stable browser identity.`);
  recordTabLifecycle(session.name, browserIdentity, targetId, retained);
}

async function targetsForEndpoint(endpoint, browserIdentity, sessionName) {
  if (!endpoint) return [];
  const normalized = String(endpoint).replace(/\/$/, "");
  const targets = await fetchJson(`${normalized}/json/list`);
  return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl).map((target) => {
    const publicTarget = {
      id: String(target.id), title: boundedText(target.title, 500), url: boundedText(target.url, 4000), endpoint: normalized,
    };
    return { ...publicTarget, claim: targetClaim(browserIdentity, publicTarget), ...tabLifecycle(sessionName, browserIdentity, publicTarget.id) };
  });
}

async function listAttachedBrowserSessions() {
  const sessions = await Promise.all(configuredAttachEndpoints().map(async (endpoint) => {
    try {
      const version = await fetchJson(`${endpoint}/json/version`);
      const browserSocket = String(version?.webSocketDebuggerUrl ?? "");
      if (!browserSocket) return null;
      const identity = new URL(browserSocket).pathname;
      const name = `attached-${createHash("sha256").update(endpoint).update("\0").update(identity).digest("hex").slice(0, 16)}`;
      return {
        name, kind: "attached", running: true, endpoint, pid: null,
        browser: boundedText(version.Browser, 500),
        targets: await targetsForEndpoint(endpoint, identity, name),
      };
    } catch { return null; }
  }));
  return sessions.filter(Boolean);
}

async function listExtensionBrowserSessions() {
  await startBrowserExtensionBridge();
  return listBrowserExtensionConnections().map((connection) => {
    const name = `extension-${createHash("sha256").update(connection.instanceId).digest("hex").slice(0, 16)}`;
    const browserIdentity = `extension:${connection.instanceId}:${connection.generation}`;
    const endpoint = `extension://${connection.instanceId}`;
    const targets = connection.tabs.map((tab) => {
      const target = { id: String(tab.id), title: boundedText(tab.title, 500), url: boundedText(tab.url, 4000), endpoint };
      return {
        ...target,
        claim: targetClaim(browserIdentity, target),
        owner: tab.owner === "automation" ? "automation" : "user",
        retained: tab.owner === "automation" ? tab.retained === true : true,
      };
    });
    return { name, kind: "extension", running: true, endpoint, pid: null, browser: boundedText(connection.browser, 500), extensionInstanceId: connection.instanceId, browserIdentity, targets };
  });
}

async function describeBrowserSession(name) {
  const normalized = normalizeSessionName(name);
  if (normalized.startsWith("extension-")) {
    const extension = (await listExtensionBrowserSessions()).find((item) => item.name === normalized);
    return extension ?? { name: normalized, kind: "extension", running: false, endpoint: null, pid: null, targets: [] };
  }
  if (normalized.startsWith("attached-")) {
    const attached = (await listAttachedBrowserSessions()).find((item) => item.name === normalized);
    return attached ?? { name: normalized, kind: "attached", running: false, endpoint: null, pid: null, targets: [] };
  }
  const paths = pathsForSession(normalized);
  const [metadata, descriptor] = await Promise.all([readJson(paths.metadata), readDevToolsDescriptor(paths.devtoolsPort)]);
  const endpoint = descriptor?.endpoint ?? null;
  const running = await endpointIsAlive(endpoint, descriptor?.browserPath ?? "");
  const targets = running ? await targetsForEndpoint(endpoint, descriptor.browserPath, normalized) : [];
  return {
    name: normalized,
    kind: "managed",
    running,
    endpoint: running ? endpoint : null,
    pid: running && Number.isInteger(metadata?.pid) ? metadata.pid : null,
    targets,
  };
}

function assertTargetClaim(session, targetId, claim) {
  const selected = session.targets.find((target) => target.id === String(targetId));
  if (!selected) throw new Error(`Browser target ${targetId} is not part of browser session ${session.name}.`);
  if (!claim || String(claim) !== selected.claim) {
    throw new Error(`Browser target ${targetId} claim is missing or stale. Refresh computer_browser_session list and use its current target claim.`);
  }
  return selected;
}

async function freshManagedTarget(session, targetId, claim = "", requireClaim = false) {
  const selected = requireClaim
    ? assertTargetClaim(session, targetId, claim)
    : session.targets.find((target) => target.id === String(targetId));
  if (!selected) throw new Error(`Browser target ${targetId} is not part of browser session ${session.name}.`);
  if (session.kind === "extension") {
    const listed = await browserExtensionRequest(session.extensionInstanceId, "list_tabs");
    const fresh = (listed?.tabs ?? []).find((item) => String(item.id) === selected.id);
    if (!fresh) throw new Error(`Browser target ${targetId} is stale or no longer available in browser session ${session.name}.`);
    if (requireClaim && (String(fresh.title ?? "") !== selected.title || String(fresh.url ?? "") !== selected.url)) {
      throw new Error(`Browser target ${targetId} changed after its claim was issued. Refresh computer_browser_session list before acting.`);
    }
    await browserExtensionRequest(session.extensionInstanceId, "claim_tab", {
      targetId: selected.id,
      title: selected.title,
      url: selected.url,
    });
    return { ...selected, title: String(fresh.title ?? ""), url: String(fresh.url ?? ""), webSocketDebuggerUrl: null };
  }
  const items = await fetchJson(`${session.endpoint}/json/list`, 2_000);
  const fresh = items.find((item) => item.type === "page" && String(item.id) === selected.id && item.webSocketDebuggerUrl);
  if (!fresh) throw new Error(`Browser target ${targetId} is stale or no longer belongs to browser session ${session.name}.`);
  if (requireClaim && (String(fresh.title ?? "") !== selected.title || String(fresh.url ?? "") !== selected.url)) {
    throw new Error(`Browser target ${targetId} changed after its claim was issued. Refresh computer_browser_session list before acting.`);
  }
  return {
    id: String(fresh.id),
    title: String(fresh.title ?? ""),
    url: String(fresh.url ?? ""),
    endpoint: session.endpoint,
    claim: selected.claim,
    owner: selected.owner,
    retained: selected.retained,
    webSocketDebuggerUrl: String(fresh.webSocketDebuggerUrl),
  };
}

async function ensureTargetMonitor(session, targetId, claim = "", requireClaim = false) {
  const fresh = await freshManagedTarget(session, targetId, claim, requireClaim);
  const key = `${session.name}:${fresh.id}`;
  const existing = TARGET_MONITORS.get(key);
  if (existing?.endpoint === session.endpoint && existing.client.socket?.readyState === WebSocket.OPEN) {
    existing.target = fresh;
    return existing;
  }
  existing?.client.close();

  const monitor = {
    key,
    endpoint: session.endpoint,
    target: fresh,
    client: session.kind === "extension" ? new ExtensionCdpClient(session.extensionInstanceId, fresh.id) : new CdpClient(fresh.webSocketDebuggerUrl),
    logs: [],
    dialog: null,
  };
  const browserIdentity = session.kind === "extension"
    ? session.browserIdentity
    : new URL(String((await fetchJson(`${session.endpoint}/json/version`, 2_000))?.webSocketDebuggerUrl ?? "")).pathname;
  monitor.client.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args ?? []).map((argument) => {
      if (argument.value !== undefined) return typeof argument.value === "string" ? argument.value : JSON.stringify(argument.value);
      return argument.unserializableValue ?? argument.description ?? argument.type ?? "";
    }).join(" ");
    pushLog(monitor, { level: params.type, text, source: "console", timestamp: Number(params.timestamp) * 1000 });
  });
  monitor.client.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails ?? {};
    pushLog(monitor, {
      level: "error",
      text: details.exception?.description ?? details.text ?? "Uncaught exception",
      source: "javascript",
      timestamp: Number(params.timestamp) * 1000,
      url: details.url,
      lineNumber: Number.isInteger(details.lineNumber) ? details.lineNumber : null,
    });
  });
  monitor.client.on("Log.entryAdded", ({ entry }) => pushLog(monitor, entry ?? {}));
  monitor.client.on("Page.javascriptDialogOpening", (params) => { monitor.dialog = publicDialog(params); });
  monitor.client.on("Page.javascriptDialogClosed", () => { monitor.dialog = null; });
  monitor.client.on("Target.targetCreated", ({ targetInfo }) => {
    if (String(targetInfo?.type ?? "") !== "page" || String(targetInfo?.openerId ?? "") !== fresh.id) return;
    const opener = tabLifecycle(session.name, browserIdentity, fresh.id);
    if (opener.owner === "automation") recordTabLifecycle(session.name, browserIdentity, String(targetInfo.targetId), false);
  });
  await Promise.all([
    monitor.client.send("Page.enable"),
    monitor.client.send("Runtime.enable"),
    monitor.client.send("Log.enable").catch(() => ({})),
    monitor.client.send("Target.setDiscoverTargets", { discover: true }).catch(() => ({})),
  ]);
  TARGET_MONITORS.set(key, monitor);
  return monitor;
}

async function listDownloadedFiles(paths) {
  let entries;
  try { entries = await readdir(paths.downloads, { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(paths.downloads, entry.name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    files.push({ name: entry.name, path, size: info.size, modifiedAt: info.mtime.toISOString() });
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function ensureBrowserMonitor(session) {
  const existing = BROWSER_MONITORS.get(session.name);
  if (existing?.endpoint === session.endpoint && existing.client.socket?.readyState === WebSocket.OPEN) return existing;
  existing?.client.close();
  const version = await fetchJson(`${session.endpoint}/json/version`, 2_000);
  if (!version?.webSocketDebuggerUrl) throw new Error(`Browser session ${session.name} has no browser DevTools channel.`);
  const paths = pathsForSession(session.name);
  await mkdir(paths.downloads, { recursive: true, mode: 0o700 });
  const monitor = {
    endpoint: session.endpoint,
    client: new CdpClient(String(version.webSocketDebuggerUrl)),
    paths,
    downloads: new Map(),
  };
  monitor.client.on("Browser.downloadWillBegin", (params) => {
    monitor.downloads.set(String(params.guid), {
      guid: String(params.guid),
      url: boundedText(params.url, 4000),
      suggestedFilename: basename(String(params.suggestedFilename ?? "download")),
      state: "inProgress",
      receivedBytes: 0,
      totalBytes: null,
    });
  });
  monitor.client.on("Browser.downloadProgress", (params) => {
    const guid = String(params.guid);
    const current = monitor.downloads.get(guid) ?? { guid, url: "", suggestedFilename: "", state: "inProgress", receivedBytes: 0, totalBytes: null };
    current.state = String(params.state ?? current.state);
    current.receivedBytes = Number(params.receivedBytes) || 0;
    current.totalBytes = Number.isFinite(Number(params.totalBytes)) ? Number(params.totalBytes) : null;
    monitor.downloads.set(guid, current);
  });
  await monitor.client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: paths.downloads,
    eventsEnabled: true,
  });
  BROWSER_MONITORS.set(session.name, monitor);
  return monitor;
}

async function ensureSessionMonitors(session) {
  if (!session.running || !session.endpoint) return;
  if (!["attached", "extension"].includes(session.kind)) await ensureBrowserMonitor(session);
  await Promise.all(session.targets.map((target) => ensureTargetMonitor(session, target.id).catch(() => null)));
}

function closeSessionMonitors(name, targetId = "") {
  if (targetId) {
    const key = `${name}:${targetId}`;
    TARGET_MONITORS.get(key)?.client.close();
    TARGET_MONITORS.delete(key);
    return;
  }
  for (const [key, monitor] of TARGET_MONITORS) {
    if (!key.startsWith(`${name}:`)) continue;
    monitor.client.close();
    TARGET_MONITORS.delete(key);
  }
  BROWSER_MONITORS.get(name)?.client.close();
  BROWSER_MONITORS.delete(name);
}

async function waitForSessionEndpoint(paths, spawnErrorRef) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnErrorRef.error) throw spawnErrorRef.error;
    const descriptor = await readDevToolsDescriptor(paths.devtoolsPort);
    if (descriptor?.endpoint && await endpointIsAlive(descriptor.endpoint, descriptor.browserPath)) return descriptor.endpoint;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not expose a loopback DevTools endpoint within ${START_TIMEOUT_MS}ms.`);
}

export async function listBrowserSessions() {
  let entries;
  try { entries = await readdir(sessionRoot(), { withFileTypes: true }); }
  catch { entries = []; }
  const names = entries.filter((entry) => entry.isDirectory() && SESSION_NAME_RE.test(entry.name)).map((entry) => entry.name).sort();
  const [managed, attached, extension] = await Promise.all([
    Promise.all(names.map((name) => describeBrowserSession(name))),
    listAttachedBrowserSessions(),
    listExtensionBrowserSessions(),
  ]);
  return [...managed, ...attached, ...extension];
}

export async function startBrowserSession({ name, url = "about:blank", headless = false } = {}) {
  const normalized = normalizeSessionName(name);
  if (normalized.startsWith("attached-") || normalized.startsWith("extension-")) throw new Error("Browser session names beginning with attached- or extension- are reserved for explicitly configured existing browsers.");
  const normalizedUrl = normalizeNavigationUrl(url || "about:blank");
  const paths = pathsForSession(normalized);
  await mkdir(paths.profile, { recursive: true, mode: 0o700 });

  const existing = await describeBrowserSession(normalized);
  if (existing.running) {
    if (normalizedUrl !== "about:blank" && existing.targets.length) {
      await navigateBrowserTarget({ endpoint: existing.endpoint, targetId: existing.targets[0].id, navigateTo: normalizedUrl });
    }
    const described = await describeBrowserSession(normalized);
    await ensureSessionMonitors(described);
    return described;
  }

  await rm(paths.devtoolsPort, { force: true }).catch(() => {});
  const executable = await resolveChromeExecutable();
  const args = [
    `--user-data-dir=${paths.profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-session-crashed-bubble",
    "--window-size=1280,800",
  ];
  if (headless) args.push("--headless=new");
  args.push(normalizedUrl);

  let child;
  let launchMode = "direct";
  if (platform() === "darwin" && !headless) {
    const marker = ".app/Contents/MacOS/";
    const markerIndex = executable.indexOf(marker);
    const appBundle = markerIndex >= 0 ? executable.slice(0, markerIndex + 4) : "";
    if (appBundle) {
      launchMode = "launchservices";
      child = spawn("/usr/bin/open", ["-n", appBundle, "--args", ...args], { detached: true, stdio: "ignore" });
    } else {
      child = spawn(executable, args, { detached: true, stdio: "ignore" });
    }
  } else {
    child = spawn(executable, args, { detached: true, stdio: "ignore" });
  }
  const spawnErrorRef = { error: null };
  child.once("error", (error) => { spawnErrorRef.error = error; });
  child.unref();
  if (!Number.isInteger(child.pid)) throw new Error("Chrome launcher did not start with a process id.");

  await writeFile(paths.metadata, JSON.stringify({
    name: normalized,
    pid: launchMode === "direct" ? child.pid : null,
    executable,
    launchMode,
    headless: Boolean(headless),
    launchedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });

  await waitForSessionEndpoint(paths, spawnErrorRef);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const described = await describeBrowserSession(normalized);
    if (described.targets.length) {
      await Promise.all(described.targets.map((target) => setTabLifecycle(described, target.id, false)));
      const owned = await describeBrowserSession(normalized);
      await ensureSessionMonitors(owned);
      return owned;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const described = await describeBrowserSession(normalized);
  await ensureSessionMonitors(described);
  return described;
}

async function closeBrowserEndpoint(endpoint) {
  const version = await fetchJson(`${endpoint}/json/version`, 2_000);
  const socketUrl = version?.webSocketDebuggerUrl;
  if (!socketUrl) throw new Error("Managed Chrome session did not expose a browser DevTools WebSocket.");
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, { perMessageDeflate: false });
    let settled = false;
    let sent = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Timed out while closing the managed Chrome session.")), 4_000);
    socket.once("open", () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.id !== 1) return;
      if (message.error) finish(new Error(message.error.message || "Browser.close failed."));
      else finish();
    });
    socket.once("close", () => { if (sent) finish(); });
    socket.once("error", (error) => finish(error));
  });
}

export async function stopBrowserSession({ name } = {}) {
  const normalized = normalizeSessionName(name);
  const session = await describeBrowserSession(normalized);
  if (["attached", "extension"].includes(session.kind)) throw new Error("Attached and extension browser sessions cannot be stopped; disconnect the endpoint/extension or close the browser yourself.");
  if (!session.running || !session.endpoint) {
    closeSessionMonitors(normalized);
    return session;
  }
  closeSessionMonitors(normalized);
  await closeBrowserEndpoint(session.endpoint);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await endpointIsAlive(session.endpoint)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return describeBrowserSession(normalized);
}

export async function navigateBrowserSession({ name, url, targetId = "", targetClaim: claim = "" } = {}) {
  const normalized = normalizeSessionName(name);
  if (!url) throw new Error("url is required for browser session navigation.");
  const normalizedUrl = normalizeNavigationUrl(url);
  const session = await describeBrowserSession(normalized);
  if (!session.running || !session.endpoint) throw new Error(`Browser session ${normalized} is not running.`);
  if (!targetId) throw new Error("Browser navigation requires an exact targetId and targetClaim.");
  const selected = assertTargetClaim(session, targetId, claim);
  let result;
  if (session.kind === "extension") {
    const monitor = await ensureTargetMonitor(session, selected.id);
    const navigation = await monitor.client.send("Page.navigate", { url: normalizedUrl });
    if (navigation?.errorText) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    await waitForExtensionDocument(monitor.client);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const captured = await monitor.client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }).catch(() => null);
    result = { screenshot: captured?.data ? { data: String(captured.data), mimeType: "image/png" } : null };
  } else result = await navigateBrowserTarget({ endpoint: session.endpoint, targetId: selected.id, navigateTo: normalizedUrl });
  const described = await describeBrowserSession(normalized);
  await ensureTargetMonitor(described, selected.id);
  return { session: described, target: described.targets.find((target) => target.id === selected.id) ?? null, screenshot: result.screenshot };
}

export async function browserSessionTabAction({ name, action, targetId = "", targetClaim: claim = "", url = "" } = {}) {
  const normalized = normalizeSessionName(name);
  const session = await describeBrowserSession(normalized);
  if (!session.running || !session.endpoint) throw new Error(`Browser session ${normalized} is not running.`);

  let result;
  if (session.kind === "extension") {
    if (action === "new_tab") {
      const created = await browserExtensionRequest(session.extensionInstanceId, "create_tab", { url: normalizeNavigationUrl(url || "about:blank"), retained: false });
      result = { target: { id: String(created.targetId) }, screenshot: null };
    } else if (action === "cleanup_tabs") {
      await browserExtensionRequest(session.extensionInstanceId, "cleanup_tabs");
      result = { target: null, screenshot: null };
    } else {
      if (!targetId) throw new Error(`${action} requires an exact targetId and targetClaim.`);
      const selected = assertTargetClaim(session, targetId, claim);
      await browserExtensionRequest(session.extensionInstanceId, "claim_tab", { targetId: selected.id, title: selected.title, url: selected.url });
      if (["back", "forward", "reload", "screenshot"].includes(action)) {
        const monitor = await ensureTargetMonitor(session, selected.id);
        if (action === "reload") await monitor.client.send("Page.reload", { ignoreCache: false });
        else if (action === "back" || action === "forward") {
          const history = await monitor.client.send("Page.getNavigationHistory");
          const entry = history.entries?.[Number(history.currentIndex) + (action === "back" ? -1 : 1)];
          if (!entry) throw new Error(`Browser target cannot navigate ${action}; there is no matching history entry.`);
          await monitor.client.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        }
        if (action !== "screenshot") await waitForExtensionDocument(monitor.client);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const captured = await monitor.client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }).catch(() => null);
        result = { target: selected, screenshot: captured?.data ? { data: String(captured.data), mimeType: "image/png" } : null };
      } else {
        await browserExtensionRequest(session.extensionInstanceId, "tab_action", { action, targetId: selected.id });
        if (action === "close_tab") closeSessionMonitors(normalized, selected.id);
        result = { target: selected, screenshot: null };
      }
    }
  } else if (action === "new_tab") {
    result = await createBrowserTarget({ endpoint: session.endpoint, url: normalizeNavigationUrl(url || "about:blank") });
    await setTabLifecycle(session, result.target.id, false);
  } else if (action === "cleanup_tabs") {
    const disposable = session.targets.filter((target) => target.owner === "automation" && !target.retained);
    await Promise.all(disposable.map(async (target) => {
      await closeBrowserTarget({ endpoint: session.endpoint, targetId: target.id });
      closeSessionMonitors(normalized, target.id);
      TAB_LIFECYCLES.delete(tabLifecycleKey(normalized, target.id));
    }));
    result = { target: null, screenshot: null };
  } else {
    if (!targetId) throw new Error(`${action} requires an exact targetId and targetClaim.`);
    const selected = assertTargetClaim(session, targetId, claim);
    const options = { endpoint: session.endpoint, targetId: selected.id };
    if (action === "retain_tab" || action === "release_tab") {
      if (selected.owner !== "automation") throw new Error(`${action} applies only to tabs created by this automation session.`);
      await setTabLifecycle(session, selected.id, action === "retain_tab");
      result = { target: selected, screenshot: null };
    } else if (action === "close_tab") {
      result = await closeBrowserTarget(options);
      closeSessionMonitors(normalized, selected.id);
      TAB_LIFECYCLES.delete(tabLifecycleKey(normalized, selected.id));
    }
    else if (action === "activate_tab") result = await activateBrowserTarget(options);
    else result = await browserTargetCommand({ ...options, action });
  }
  const described = await describeBrowserSession(normalized);
  const currentTarget = ["close_tab", "cleanup_tabs"].includes(action) ? null : described.targets.find((target) => target.id === result.target?.id) ?? null;
  if (currentTarget) await ensureTargetMonitor(described, currentTarget.id);
  return { session: described, target: currentTarget, screenshot: result.screenshot ?? null };
}

async function evaluateTarget(client, expression, { awaitPromise = false } = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Browser evaluation failed.");
  return result.result?.value;
}

async function waitForExtensionDocument(client, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluateTarget(client, "document.readyState", {}).catch(() => "");
    if (["interactive", "complete"].includes(ready)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the extension-controlled page to become ready.");
}

async function ensureClipboardDocumentFocus(monitor, timeoutMs = 2_000) {
  const hasFocus = async () => Boolean(await evaluateTarget(monitor.client, "document.hasFocus()", {}).catch(() => false));
  if (await hasFocus()) return;

  // Async Clipboard is intentionally gated on an active document even after
  // clipboardReadWrite permission has been granted. Bring only the exact
  // claimed target to the front, then wait for Chrome to report focus. This
  // avoids making clipboard reliability depend on whichever tab happened to
  // be active when the automation started.
  await monitor.client.send("Page.bringToFront");
  await evaluateTarget(monitor.client, "(() => { try { window.focus(); } catch {} return document.hasFocus(); })()", {}).catch(() => false);
  const deadline = Date.now() + Math.max(100, Math.min(Number(timeoutMs) || 2_000, 5_000));
  while (Date.now() < deadline) {
    if (await hasFocus()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Browser clipboard access requires the claimed target to become the focused page.");
}

async function publicDownloads(monitor) {
  const files = await listDownloadedFiles(monitor.paths);
  const downloads = [...monitor.downloads.values()].map((download) => {
    const file = files.find((candidate) => candidate.name === download.suggestedFilename) ?? null;
    return { ...download, path: file?.path ?? null, size: file?.size ?? null };
  });
  return { downloads, files };
}

export async function browserSessionUtility({
  name,
  action,
  targetId = "",
  targetClaim: claim = "",
  text = "",
  promptText = "",
  clear = false,
  limit = 100,
  downloadGuid = "",
  timeoutMs = 30_000,
  filename = "",
  pdfOptions = {},
} = {}) {
  const normalized = normalizeSessionName(name);
  const session = await describeBrowserSession(normalized);
  if (!session.running || !session.endpoint) throw new Error(`Browser session ${normalized} is not running.`);

  if (["downloads", "download_wait", "download_cancel"].includes(action)) {
    if (session.kind === "extension") {
      const listed = await browserExtensionRequest(session.extensionInstanceId, "downloads", { action, downloadGuid, timeoutMs });
      return { session, target: null, text: null, logs: [], dialog: null, downloads: listed?.downloads ?? [], files: [], artifacts: [] };
    }
    const monitor = await ensureBrowserMonitor(session);
    if (action === "download_cancel") {
      if (!downloadGuid) throw new Error("download_cancel requires downloadGuid.");
      await monitor.client.send("Browser.cancelDownload", { guid: String(downloadGuid) });
    } else if (action === "download_wait") {
      if (!downloadGuid) throw new Error("download_wait requires downloadGuid.");
      const deadline = Date.now() + Math.max(0, Math.min(Number(timeoutMs) || 30_000, 30_000));
      while (Date.now() < deadline) {
        const current = monitor.downloads.get(String(downloadGuid));
        if (current && ["completed", "canceled"].includes(current.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const listed = await publicDownloads(monitor);
    return { session, target: null, text: null, logs: [], dialog: null, artifacts: [], ...listed };
  }

  if (!targetId) throw new Error(`${action} requires an exact targetId from the browser session.`);
  const monitor = await ensureTargetMonitor(session, targetId, claim, true);
  const target = {
    id: monitor.target.id,
    title: monitor.target.title,
    url: monitor.target.url,
    endpoint: monitor.target.endpoint,
    claim: monitor.target.claim,
    owner: monitor.target.owner,
    retained: monitor.target.retained,
  };
  let exportedText = null;
  let logs = [];
  let dialog = monitor.dialog;
  let artifacts = [];

  if (action === "export_html") {
    await monitor.client.send("DOM.enable");
    const { root } = await monitor.client.send("DOM.getDocument", { depth: 0, pierce: true });
    const result = await monitor.client.send("DOM.getOuterHTML", { nodeId: root.nodeId });
    exportedText = String(result.outerHTML ?? "");
    if (exportedText.length > MAX_EXPORT_CHARS) throw new Error(`Exported HTML exceeds ${MAX_EXPORT_CHARS} characters.`);
  } else if (action === "export_text") {
    exportedText = String(await evaluateTarget(monitor.client, "document.body?.innerText || ''") ?? "");
    if (exportedText.length > MAX_EXPORT_CHARS) throw new Error(`Exported page text exceeds ${MAX_EXPORT_CHARS} characters.`);
  } else if (action === "export_pdf") {
    const paths = pathsForSession(normalized);
    await mkdir(paths.exports, { recursive: true, mode: 0o700 });
    const scale = Math.max(0.1, Math.min(Number(pdfOptions.scale) || 1, 2));
    const paperWidth = Math.max(1, Math.min(Number(pdfOptions.paperWidth) || 8.27, 100));
    const paperHeight = Math.max(1, Math.min(Number(pdfOptions.paperHeight) || 11.69, 100));
    const margin = (value) => Math.max(0, Math.min(Number(value) || 0, 10));
    const printed = await monitor.client.send("Page.printToPDF", {
      landscape: pdfOptions.landscape === true,
      printBackground: pdfOptions.printBackground !== false,
      scale,
      paperWidth,
      paperHeight,
      marginTop: margin(pdfOptions.marginTop), marginBottom: margin(pdfOptions.marginBottom),
      marginLeft: margin(pdfOptions.marginLeft), marginRight: margin(pdfOptions.marginRight),
      preferCSSPageSize: pdfOptions.preferCSSPageSize === true,
      transferMode: "ReturnAsBase64",
    });
    const data = Buffer.from(String(printed.data ?? ""), "base64");
    if (!data.length || data.length > MAX_PDF_BYTES) throw new Error(`PDF export must be between 1 and ${MAX_PDF_BYTES} bytes.`);
    if (data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Chrome returned an invalid PDF export.");
    const temporary = join(paths.exports, `.partial-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
    let destination;
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      destination = await uniqueExportPath(paths.exports, filename, temporary);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    artifacts = [{ kind: "pdf", name: destination.name, path: destination.path, size: data.length }];
  } else if (action === "clipboard_read" || action === "clipboard_write") {
    let origin;
    try { origin = new URL(target.url).origin; } catch { origin = "null"; }
    if (!/^https?:\/\//.test(origin)) throw new Error("Browser clipboard access requires an http or https page origin.");
    await monitor.client.send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await ensureClipboardDocumentFocus(monitor);
    if (action === "clipboard_read") {
      exportedText = String(await evaluateTarget(monitor.client, "navigator.clipboard.readText()", { awaitPromise: true }) ?? "");
    } else {
      if (String(text).length > MAX_EXPORT_CHARS) throw new Error(`Clipboard text exceeds ${MAX_EXPORT_CHARS} characters.`);
      await evaluateTarget(monitor.client, `navigator.clipboard.writeText(${JSON.stringify(String(text))})`, { awaitPromise: true });
      exportedText = null;
    }
  } else if (action === "logs") {
    logs = monitor.logs.slice(-Math.max(1, Math.min(Number(limit) || 100, MAX_LOG_ENTRIES)));
    if (clear) monitor.logs.length = 0;
  } else if (["dialog_state", "dialog_accept", "dialog_dismiss"].includes(action)) {
    if (action !== "dialog_state") {
      if (!monitor.dialog) throw new Error(`Browser target ${targetId} has no open JavaScript dialog.`);
      await monitor.client.send("Page.handleJavaScriptDialog", {
        accept: action === "dialog_accept",
        ...(action === "dialog_accept" && promptText ? { promptText: String(promptText) } : {}),
      });
      monitor.dialog = null;
      dialog = null;
    }
  } else {
    throw new Error(`Unsupported browser utility action: ${action}`);
  }

  return { session: await describeBrowserSession(normalized), target, text: exportedText, logs, dialog, downloads: [], files: [], artifacts };
}

function normalizedLocator(locator = {}) {
  const result = {
    ref: boundedText(locator.ref, 32),
    snapshotId: boundedText(locator.snapshotId, 128),
    backendNodeId: Number.isInteger(locator.backendNodeId) ? locator.backendNodeId : null,
    css: boundedText(locator.css, 2000),
    role: boundedText(locator.role, 200).toLowerCase(),
    name: boundedText(locator.name, 2000),
    text: boundedText(locator.text, 5000),
    exact: locator.exact === true,
    nth: Math.max(0, Math.min(Number(locator.nth) || 0, 10_000)),
  };
  if (!result.ref && !result.backendNodeId && !result.css && !result.role && !result.name && !result.text) {
    throw new Error("A locator requires ref, css, role, name, or text.");
  }
  return result;
}

function cleanupBrowserRefSnapshots() {
  const now = Date.now();
  for (const [id, snapshot] of BROWSER_REF_SNAPSHOTS) {
    if (snapshot.expiresAt <= now) BROWSER_REF_SNAPSHOTS.delete(id);
  }
  while (BROWSER_REF_SNAPSHOTS.size > MAX_BROWSER_REF_SNAPSHOTS) {
    BROWSER_REF_SNAPSHOTS.delete(BROWSER_REF_SNAPSHOTS.keys().next().value);
  }
}

function resolveBrowserRef(locator, binding) {
  const normalized = normalizedLocator(locator);
  if (!normalized.ref) return normalized;
  cleanupBrowserRefSnapshots();
  const snapshot = BROWSER_REF_SNAPSHOTS.get(normalized.snapshotId);
  if (!snapshot) throw new Error(`Browser snapshot ${normalized.snapshotId || "(missing)"} is stale or unknown. Take a fresh computer_browser_snapshot.`);
  if (snapshot.session !== binding.session || snapshot.targetId !== binding.targetId || snapshot.targetClaim !== binding.targetClaim) {
    throw new Error("Browser snapshot does not belong to the exact claimed target.");
  }
  const ref = normalized.ref.startsWith("@") ? normalized.ref : `@${normalized.ref}`;
  const entry = snapshot.refs.get(ref);
  if (!entry) throw new Error(`Unknown browser snapshot ref ${ref}.`);
  return { ...normalized, ref, backendNodeId: entry.backendNodeId };
}

function locatorRuntimeExpression(locator, { all = false, limit = 100 } = {}) {
  const config = JSON.stringify(normalizedLocator(locator));
  return `(() => {
    const c = ${config};
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const element of roots[i].querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    let candidates = [];
    if (c.css) {
      for (const root of roots) candidates.push(...root.querySelectorAll(c.css));
    } else {
      for (const root of roots) candidates.push(...root.querySelectorAll('*'));
    }
    candidates = [...new Set(candidates)];
    const implicitRole = (el) => {
      const explicit = el.getAttribute('role'); if (explicit) return explicit.toLowerCase();
      const tag = el.tagName.toLowerCase(), type = String(el.type || '').toLowerCase();
      if (tag === 'button' || (tag === 'input' && ['button','submit','reset','image'].includes(type))) return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'textarea' || (tag === 'input' && !['button','submit','reset','image','checkbox','radio','range','file','color','hidden'].includes(type))) return 'textbox';
      if (tag === 'input' && type === 'checkbox') return 'checkbox';
      if (tag === 'input' && type === 'radio') return 'radio';
      if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'option') return 'option';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return '';
    };
    const accessibleName = (el) => {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) {
        const value = labelled.split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
        if (value) return value;
      }
      return String(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
        (el.labels ? [...el.labels].map(label => label.innerText).join(' ') : '') ||
        (['INPUT','TEXTAREA','SELECT'].includes(el.tagName) ? el.value : '') || el.innerText || '').trim();
    };
    const matches = (actual, expected) => c.exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
    candidates = candidates.filter(el => {
      if (c.role && implicitRole(el) !== c.role) return false;
      if (c.name && !matches(accessibleName(el), c.name)) return false;
      if (c.text && !matches(String(el.innerText || el.textContent || '').trim(), c.text)) return false;
      return true;
    });
    const summary = (el, index) => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      return {
        index, tag: el.tagName.toLowerCase(), role: implicitRole(el), name: accessibleName(el).slice(0,2000),
        text: String(el.innerText || el.textContent || '').trim().slice(0,5000), value: String(el.value ?? '').slice(0,5000),
        checked: typeof el.checked === 'boolean' ? el.checked : null, disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        visible, bounds: {x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}
      };
    };
    ${all ? `return candidates.slice(0, ${Math.max(1, Math.min(Number(limit) || 100, 500))}).map(summary);` : "return candidates[c.nth] || null;"}
  })()`;
}

async function locatorMatches(client, locator, limit = 100, contextId) {
  const result = await client.send("Runtime.evaluate", {
    expression: locatorRuntimeExpression(locator, { all: true, limit }),
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Locator query failed.");
  return Array.isArray(result.result?.value) ? result.result.value : [];
}

async function resolveLocatorObject(client, locator, contextId) {
  if (locator.backendNodeId) {
    const result = await client.send("DOM.resolveNode", {
      backendNodeId: locator.backendNodeId,
      objectGroup: "computer-browser-locator",
      ...(contextId ? { executionContextId: contextId } : {}),
    });
    return result.object?.objectId ?? null;
  }
  const result = await client.send("Runtime.evaluate", {
    expression: locatorRuntimeExpression(locator),
    returnByValue: false,
    objectGroup: "computer-browser-locator",
    ...(contextId ? { contextId } : {}),
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Locator query failed.");
  if (!result.result?.objectId || result.result.subtype === "null") return null;
  return result.result.objectId;
}

function isOutOfProcessLocatorFrameError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /no frame for given id found/i.test(message);
}

function locatorChildSessionClient(rootClient, sessionId) {
  return {
    send(method, params = {}) {
      return rootClient.sendSession(sessionId, method, params);
    },
  };
}

async function findLocatorFrameTarget(rootClient, frameId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const listed = await rootClient.send("Target.getTargets");
    const target = (listed.targetInfos ?? []).find((item) => String(item.targetId ?? "") === frameId && String(item.type ?? "") === "iframe");
    if (target) return target;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  return null;
}

async function resolveLocatorScope(rootClient, frames = []) {
  const chain = Array.isArray(frames) ? frames.slice(0, 8) : [];
  let client = rootClient;
  let contextId;
  let parentSessionId = "";
  const childSessions = [];
  const cleanup = async () => {
    for (const sessionId of childSessions.reverse()) {
      await rootClient.send("Target.detachFromTarget", { sessionId }).catch(() => ({}));
    }
  };

  try {
    for (let index = 0; index < chain.length; index += 1) {
      const locator = normalizedLocator(chain[index]);
      if (locator.ref) throw new Error("Snapshot refs identify page elements, not frame-chain locators. Use CSS/role/name/text for frames.");
      const ownerClient = client;
      const frameObjectId = await resolveLocatorObject(ownerClient, locator, contextId);
      if (!frameObjectId) throw new Error(`Frame locator ${index} matched no element.`);
      try {
        const isFrame = await callLocatorObject(ownerClient, frameObjectId, "function(){return this instanceof HTMLIFrameElement||this instanceof HTMLFrameElement;}");
        if (!isFrame) throw new Error(`Frame locator ${index} did not match an iframe or frame element.`);
        const { node } = await ownerClient.send("DOM.describeNode", { objectId: frameObjectId, depth: 0 });
        const frameId = String(node?.frameId ?? "");
        if (!frameId) throw new Error(`Frame locator ${index} has no live CDP frame identity.`);

        try {
          const world = await ownerClient.send("Page.createIsolatedWorld", {
            frameId,
            worldName: "computer-browser-locator",
            grantUniveralAccess: false,
          });
          if (!world.executionContextId) throw new Error(`Could not create an isolated context for frame locator ${index}.`);
          contextId = world.executionContextId;
          continue;
        } catch (error) {
          if (!isOutOfProcessLocatorFrameError(error)) throw error;
        }

        if (typeof rootClient.sendSession !== "function") {
          throw new Error(`Frame locator ${index} requires flat CDP child-session support.`);
        }
        let attached;
        let persistentChildSession = false;
        if (typeof rootClient.attachFrameTarget === "function") {
          attached = await rootClient.attachFrameTarget(frameId, parentSessionId);
          persistentChildSession = true;
        } else {
          const target = await findLocatorFrameTarget(rootClient, frameId);
          if (!target) throw new Error(`Frame locator ${index} refers to an out-of-process frame target that is no longer available.`);
          attached = await rootClient.send("Target.attachToTarget", { targetId: frameId, flatten: true });
        }
        const sessionId = String(attached.sessionId ?? "");
        if (!sessionId) throw new Error(`Could not attach to out-of-process frame locator ${index}.`);
        if (!persistentChildSession) childSessions.push(sessionId);
        parentSessionId = sessionId;
        client = locatorChildSessionClient(rootClient, sessionId);
        await Promise.all([
          client.send("Runtime.enable"),
          client.send("Page.enable"),
          client.send("DOM.enable"),
        ]);
        const tree = await client.send("Page.getFrameTree");
        const liveFrameId = String(tree.frameTree?.frame?.id ?? "");
        if (liveFrameId !== frameId) {
          throw new Error(`Frame locator ${index} changed while attaching to its out-of-process target.`);
        }
        const world = await client.send("Page.createIsolatedWorld", {
          frameId: liveFrameId,
          worldName: "computer-browser-locator",
          grantUniveralAccess: false,
        });
        if (!world.executionContextId) throw new Error(`Could not create an isolated context for frame locator ${index}.`);
        contextId = world.executionContextId;
      } finally {
        await ownerClient.send("Runtime.releaseObject", { objectId: frameObjectId }).catch(() => ({}));
      }
    }
    return { client, contextId, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function callLocatorObject(client, objectId, functionDeclaration, args = []) {
  const result = await client.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Locator action failed.");
  return result.result?.value;
}

async function locatorObjectSummary(client, objectId) {
  return callLocatorObject(client, objectId, `function(){
    const rect=this.getBoundingClientRect(),style=getComputedStyle(this);
    return {index:0,tag:this.tagName.toLowerCase(),role:String(this.getAttribute('role')||''),name:String(this.getAttribute('aria-label')||this.innerText||this.value||'').trim().slice(0,2000),text:String(this.innerText||this.textContent||'').trim().slice(0,5000),value:String(this.value??'').slice(0,5000),checked:typeof this.checked==='boolean'?this.checked:null,disabled:Boolean(this.disabled||this.getAttribute('aria-disabled')==='true'),visible:style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0&&rect.width>0&&rect.height>0,bounds:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}};
  }`);
}

async function locatorObjectCenter(client, objectId) {
  const { node } = await client.send("DOM.describeNode", { objectId, depth: 0 });
  const model = await client.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
  const quad = model.model?.border ?? model.model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("Located element has no visible box.");
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, backendNodeId: node.backendNodeId };
}

async function dispatchLocatorClick(client, objectId, { button = "left", count = 1 } = {}) {
  await callLocatorObject(client, objectId, "function(){this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});this.focus?.();}");
  const point = await locatorObjectCenter(client, objectId);
  const selectedButton = ["left", "right", "middle"].includes(button) ? button : "left";
  const clickCount = Math.max(1, Math.min(Number(count) || 1, 3));
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: selectedButton, clickCount });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: selectedButton, clickCount });
}

async function dispatchLocatorDrag(client, sourceObjectId, targetObjectId) {
  await callLocatorObject(client, sourceObjectId, "function(){this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});}");
  await callLocatorObject(client, targetObjectId, "function(){this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});}");
  const source = await locatorObjectCenter(client, sourceObjectId);
  const target = await locatorObjectCenter(client, targetObjectId);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: source.x, y: source.y, button: "none" });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: source.x, y: source.y, button: "left", buttons: 1, clickCount: 1 });
  try {
    for (let index = 1; index <= 12; index += 1) {
      const fraction = index / 12;
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: source.x + ((target.x - source.x) * fraction),
        y: source.y + ((target.y - source.y) * fraction),
        button: "left",
        buttons: 1,
      });
    }
  } finally {
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => ({}));
  }
}

async function dispatchLocatorKey(client, rawKey) {
  const parts = String(rawKey ?? "").split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("press_key requires key.");
  const modifiers = parts.slice(0, -1).reduce((mask, part) => {
    const key = part.toLowerCase();
    return mask | (key === "alt" || key === "option" ? 1 : key === "control" || key === "ctrl" || key === "controlormeta" ? 2 : key === "meta" || key === "command" || key === "cmd" || key === "super" ? 4 : key === "shift" ? 8 : 0);
  }, 0);
  const aliases = { return: "Enter", enter: "Enter", esc: "Escape", escape: "Escape", space: " ", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", tab: "Tab", backspace: "Backspace", delete: "Delete", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
  const requested = parts.at(-1);
  const key = aliases[requested.toLowerCase()] ?? requested;
  const keyCodes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };
  const windowsVirtualKeyCode = keyCodes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const params = { key, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await client.send("Input.dispatchKeyEvent", { type: key.length === 1 ? "keyDown" : "rawKeyDown", ...params, ...(key.length === 1 ? { text: key } : {}) });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

function cuaCoordinate(value, label) {
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 100_000) throw new Error(`${label} must be a finite coordinate between 0 and 100000.`);
  return coordinate;
}

function cuaButton(value) {
  if (Number.isInteger(value)) {
    const names = { 1: "left", 2: "middle", 3: "right", 4: "back", 5: "forward" };
    return names[value] ?? "left";
  }
  return ["left", "right", "middle", "back", "forward"].includes(String(value)) ? String(value) : "left";
}

function cuaButtonMask(button) {
  return { left: 1, right: 2, middle: 4, back: 8, forward: 16 }[button] ?? 0;
}

function cuaModifierMask(keys) {
  const values = Array.isArray(keys) ? keys : [];
  return values.reduce((mask, rawKey) => {
    const key = String(rawKey ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (["alt", "option"].includes(key)) return mask | 1;
    if (["control", "ctrl", "controlormeta"].includes(key)) return mask | 2;
    if (["meta", "command", "cmd", "super", "windows", "win"].includes(key)) return mask | 4;
    if (key === "shift") return mask | 8;
    return mask;
  }, 0);
}

function cuaKeys(action) {
  if (Array.isArray(action?.keypress)) return action.keypress.map((key) => String(key)).filter(Boolean);
  if (Array.isArray(action?.keys)) return action.keys.map((key) => String(key)).filter(Boolean);
  if (action?.key !== undefined && action?.key !== null) return String(action.key).split("+").map((key) => key.trim()).filter(Boolean);
  return [];
}

function cuaModifierKeys(action) {
  if (Array.isArray(action?.keys) || Array.isArray(action?.keypress)) return cuaKeys(action);
  return cuaKeys(action).slice(0, -1);
}

function cuaPoint(x, y, prefix = "point") {
  if (x === undefined || y === undefined) throw new Error(`${prefix} requires x and y.`);
  return { x: cuaCoordinate(x, `${prefix}.x`), y: cuaCoordinate(y, `${prefix}.y`) };
}

function cuaDragPath(action) {
  if (Array.isArray(action?.path) && action.path.length >= 2) {
    if (action.path.length > 100) throw new Error("Browser CUA drag path allows at most 100 points.");
    return action.path.map((point, index) => cuaPoint(point?.x, point?.y, `path[${index}]`));
  }
  if ([action?.fromX, action?.fromY, action?.toX, action?.toY].every((value) => value !== undefined)) {
    const from = cuaPoint(action.fromX, action.fromY, "from");
    const to = cuaPoint(action.toX, action.toY, "to");
    const steps = Math.max(2, Math.min(Number(action.steps) || 12, 60));
    return Array.from({ length: steps + 1 }, (_, index) => {
      const fraction = index / steps;
      return { x: from.x + ((to.x - from.x) * fraction), y: from.y + ((to.y - from.y) * fraction) };
    });
  }
  throw new Error("Browser CUA drag requires path or fromX/fromY/toX/toY.");
}

async function browserCuaClick(client, action, countOverride = null) {
  const x = cuaCoordinate(action.x, "x");
  const y = cuaCoordinate(action.y, "y");
  const button = cuaButton(action.button);
  const count = countOverride ?? Math.max(1, Math.min(Number(action.count) || 1, 3));
  const modifiers = cuaModifierMask(cuaModifierKeys(action));
  const buttons = cuaButtonMask(button);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: count, modifiers });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: count, modifiers });
}

async function browserCuaDrag(client, action) {
  const path = cuaDragPath(action);
  const modifiers = cuaModifierMask(cuaKeys(action));
  const [start] = path;
  const end = path.at(-1);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, button: "none", modifiers });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1, modifiers });
  try {
    for (const point of path.slice(1)) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1, modifiers });
    }
  } finally {
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1, modifiers }).catch(() => ({}));
  }
}

async function browserCuaScroll(client, action) {
  const x = action.x === undefined && action.y === undefined ? 0 : cuaPoint(action.x, action.y, "scroll").x;
  const y = action.x === undefined && action.y === undefined ? 0 : cuaPoint(action.x, action.y, "scroll").y;
  let deltaX = action.scrollX;
  let deltaY = action.scrollY;
  if ((deltaX === undefined) !== (deltaY === undefined)) throw new Error("Browser CUA scrollX and scrollY must be supplied together.");
  if (deltaX === undefined && deltaY === undefined) {
    const direction = String(action.direction ?? "down").toLowerCase();
    if (!["up", "down", "left", "right"].includes(direction)) throw new Error("Browser CUA scroll direction must be up, down, left, or right.");
    const amount = Math.max(1, Math.min(Number(action.pages) || 1, 100)) * 640;
    const sign = ["up", "left"].includes(direction) ? -1 : 1;
    deltaX = ["left", "right"].includes(direction) ? sign * amount : 0;
    deltaY = ["up", "down"].includes(direction) ? sign * amount : 0;
  }
  deltaX = Number(deltaX); deltaY = Number(deltaY);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 100_000 || Math.abs(deltaY) > 100_000) {
    throw new Error("Browser CUA scroll deltas must be finite and between -100000 and 100000.");
  }
  const modifiers = cuaModifierMask(cuaKeys(action));
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers });
  await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, modifiers });
}

function screenshotDimension(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_CUA_SCREENSHOT_DIMENSION) throw new Error(`${label} must be greater than zero and at most ${MAX_CUA_SCREENSHOT_DIMENSION}.`);
  return number;
}

function isBrowserScreenshotTimeout(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Page\.captureScreenshot timed out/i.test(message);
}

async function captureBrowserCuaScreenshot(client, options = {}) {
  let clip = null;
  let captureBeyondViewport = false;
  if (options.fullPage === true) {
    const metrics = await client.send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize ?? {};
    const width = screenshotDimension(size.width, "fullPage width");
    const height = screenshotDimension(size.height, "fullPage height");
    if (width * height > MAX_CUA_SCREENSHOT_AREA) throw new Error(`Full-page browser CUA screenshot exceeds ${MAX_CUA_SCREENSHOT_AREA} CSS pixels.`);
    clip = { x: 0, y: 0, width, height, scale: 1 };
    captureBeyondViewport = true;
  } else if (options.clip) {
    const x = cuaCoordinate(options.clip.x, "clip.x");
    const y = cuaCoordinate(options.clip.y, "clip.y");
    const width = screenshotDimension(options.clip.width, "clip.width");
    const height = screenshotDimension(options.clip.height, "clip.height");
    const scale = Number(options.clip.scale ?? 1);
    if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("clip.scale must be greater than zero and at most 4.");
    if (width * height > MAX_CUA_SCREENSHOT_AREA) throw new Error(`Clipped browser CUA screenshot exceeds ${MAX_CUA_SCREENSHOT_AREA} CSS pixels.`);
    clip = { x, y, width, height, scale };
  }
  const params = { format: "png", fromSurface: true, captureBeyondViewport, ...(clip ? { clip } : {}) };
  let result;
  try {
    result = await client.send("Page.captureScreenshot", params);
  } catch (error) {
    if (!isBrowserScreenshotTimeout(error)) throw error;
    await client.send("Page.bringToFront").catch(() => ({}));
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await client.send("Page.captureScreenshot", { ...params, fromSurface: false });
  }
  const data = String(result?.data ?? "");
  if (!data) return null;
  if (Buffer.byteLength(data, "base64") > 16 * 1024 * 1024) throw new Error("Browser CUA screenshot exceeds 16 MiB.");
  return { data, mimeType: "image/png" };
}

async function browserCuaDownloadMedia(client, browserMonitor, action) {
  const point = cuaPoint(action.x, action.y, "download_media");
  const existing = new Set(browserMonitor.downloads.keys());
  await browserCuaClick(client, { ...action, x: point.x, y: point.y });
  const timeoutMs = Math.max(0, Math.min(Number(action.timeoutMs ?? 30_000), 30_000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const download = [...browserMonitor.downloads.values()].find((entry) => !existing.has(entry.guid));
    if (download && ["completed", "canceled"].includes(download.state)) return download;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Browser CUA download_media did not observe a download after clicking the requested viewport point.");
}

export async function browserSessionCua({ name, targetId, targetClaim: claim = "", actions = [] } = {}) {
  const normalized = normalizeSessionName(name);
  const session = await describeBrowserSession(normalized);
  if (!session.running || !session.endpoint) throw new Error(`Browser session ${normalized} is not running.`);
  if (!targetId) throw new Error("Browser CUA requires an exact targetId and targetClaim.");
  const monitor = await ensureTargetMonitor(session, targetId, claim, true);
  const selectedActions = Array.isArray(actions) ? actions.slice(0, 20) : [];
  if (!selectedActions.length) throw new Error("Browser CUA requires at least one action.");
  let screenshotOptions = {};
  let browserMonitor = null;
  for (const action of selectedActions) {
    const kind = String(action?.action ?? "");
    if (kind === "click") await browserCuaClick(monitor.client, action);
    else if (kind === "double_click") await browserCuaClick(monitor.client, action, 2);
    else if (kind === "move") {
      const point = cuaPoint(action.x, action.y, "move");
      await monitor.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", modifiers: cuaModifierMask(cuaKeys(action)) });
    } else if (kind === "drag") await browserCuaDrag(monitor.client, action);
    else if (kind === "type") {
      if (action.text === undefined) throw new Error("Browser CUA type requires text.");
      const text = String(action.text);
      if (text.length > 200_000) throw new Error("Browser CUA type text exceeds 200000 characters.");
      await monitor.client.send("Input.insertText", { text });
    } else if (kind === "key" || kind === "keypress") {
      const keys = cuaKeys(action);
      if (!keys.length) throw new Error("Browser CUA keypress requires key or keys.");
      await dispatchLocatorKey(monitor.client, keys.join("+"));
    } else if (kind === "scroll") {
      await browserCuaScroll(monitor.client, action);
    } else if (kind === "download_media") {
      browserMonitor ??= await ensureBrowserMonitor(session);
      await browserCuaDownloadMedia(monitor.client, browserMonitor, action);
    } else if (kind === "wait") {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(Number(action.durationMs) || 100, 30_000))));
    } else if (kind === "screenshot") {
      screenshotOptions = { clip: action.clip ?? null, fullPage: action.fullPage === true };
    } else throw new Error(`Unsupported browser CUA action: ${kind}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const screenshotResult = await captureBrowserCuaScreenshot(monitor.client, screenshotOptions);
  const described = await describeBrowserSession(normalized);
  const target = described.targets.find((item) => item.id === String(targetId)) ?? null;
  return {
    session: described,
    target,
    actionCount: selectedActions.length,
    screenshot: screenshotResult,
  };
}

async function waitForLocator(client, locator, state, timeoutMs, contextId) {
  const deadline = Date.now() + Math.max(0, Math.min(Number(timeoutMs) || 5000, 30_000));
  while (true) {
    const objectId = await resolveLocatorObject(client, locator, contextId);
    let summary = null;
    if (objectId) {
      try { summary = await locatorObjectSummary(client, objectId); }
      finally { await client.send("Runtime.releaseObject", { objectId }).catch(() => ({})); }
    }
    const satisfied = state === "detached" ? !summary
      : state === "hidden" ? !summary || !summary.visible
        : state === "visible" ? Boolean(summary?.visible)
          : state === "enabled" ? Boolean(summary && !summary.disabled)
            : state === "disabled" ? Boolean(summary?.disabled)
              : Boolean(summary);
    if (satisfied) return summary;
    if (Date.now() >= deadline) throw new Error(`Locator did not reach state ${state} within ${Math.max(0, Math.min(Number(timeoutMs) || 5000, 30_000))}ms.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function performLocatorStep(client, step, sessionName, binding) {
  const action = String(step.action ?? "inspect");
  const locator = resolveBrowserRef(step.locator ?? {}, binding);
  const scope = await resolveLocatorScope(client, step.frames ?? []);
  const actionClient = scope.client;
  const contextId = scope.contextId;
  try {
    if (action === "inspect") {
      if (locator.backendNodeId) {
        const objectId = await resolveLocatorObject(actionClient, locator, contextId);
        if (!objectId) return { action, matched: false, value: null, element: null, matches: [] };
        try {
          const element = await locatorObjectSummary(actionClient, objectId);
          return { action, matched: Boolean(element), value: null, element, matches: element ? [element] : [] };
        } finally {
          await actionClient.send("Runtime.releaseObject", { objectId }).catch(() => ({}));
        }
      }
      const matches = await locatorMatches(actionClient, locator, step.limit ?? 100, contextId);
      return { action, matched: matches.length > 0, value: null, element: matches[0] ?? null, matches };
    }
    if (action === "wait_for") {
      const element = await waitForLocator(actionClient, locator, String(step.state ?? "visible"), step.timeoutMs ?? 5000, contextId);
      return { action, matched: Boolean(element), value: String(step.state ?? "visible"), element, matches: element ? [element] : [] };
    }
    const objectId = await resolveLocatorObject(actionClient, locator, contextId);
    if (!objectId) throw new Error(`Locator matched no element for action ${action}.`);
    try {
      let value = null;
      if (action === "click") await dispatchLocatorClick(actionClient, objectId, step);
      else if (action === "double_click") await dispatchLocatorClick(actionClient, objectId, { ...step, count: 2 });
      else if (action === "hover") {
        await callLocatorObject(actionClient, objectId, "function(){this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});}");
        const point = await locatorObjectCenter(actionClient, objectId);
        await actionClient.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
      } else if (action === "focus") {
        const point = await locatorObjectCenter(actionClient, objectId);
        await actionClient.send("DOM.focus", { backendNodeId: point.backendNodeId });
      } else if (action === "fill") {
        value = String(step.value ?? "");
        const accepted = await callLocatorObject(actionClient, objectId, `function(next){
          this.scrollIntoView({block:'center',inline:'center'});this.focus?.();
          if(this.isContentEditable)this.textContent=next;else if('value' in this){let p=this,s;while(p&&!s){s=Object.getOwnPropertyDescriptor(p,'value')?.set;p=Object.getPrototypeOf(p)}if(s)s.call(this,next);else this.value=next}else return false;
          this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:next}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;
        }`, [value]);
        if (!accepted) throw new Error("Located element does not accept fill.");
      } else if (action === "type") {
        value = String(step.value ?? "");
        const point = await locatorObjectCenter(actionClient, objectId);
        await actionClient.send("DOM.focus", { backendNodeId: point.backendNodeId });
        await actionClient.send("Input.insertText", { text: value });
      } else if (action === "check" || action === "uncheck") {
        const desired = action === "check";
        const current = await callLocatorObject(actionClient, objectId, "function(){return typeof this.checked==='boolean'?this.checked:null;}");
        if (current === null) throw new Error("Located element is not checkable.");
        if (current !== desired) await dispatchLocatorClick(actionClient, objectId, { button: "left", count: 1 });
      } else if (action === "select_option") {
        const values = Array.isArray(step.values) && step.values.length ? step.values.map(String) : [String(step.value ?? "")];
        value = values.join(",");
        const selected = await callLocatorObject(actionClient, objectId, `function(values){
          if(this.tagName!=='SELECT')return null;const wanted=new Set(values);let count=0;
          for(const option of this.options){const match=wanted.has(option.value)||wanted.has(option.label)||wanted.has(option.text);option.selected=match;if(match)count++}
          this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return count;
        }`, [values]);
        if (!selected) throw new Error("No requested option matched the located select element.");
      } else if (action === "set_files") {
        const isFileInput = await callLocatorObject(actionClient, objectId, "function(){return this instanceof HTMLInputElement&&this.type==='file';}");
        if (!isFileInput) throw new Error("Located element is not an input[type=file].");
        const files = await resolveBrowserUploadFiles(sessionName, step.files ?? []);
        await actionClient.send("DOM.setFileInputFiles", { objectId, files });
        value = `${files.length} file${files.length === 1 ? "" : "s"}`;
      } else if (action === "drag_to") {
        const targetLocator = resolveBrowserRef(step.target ?? {}, binding);
        const targetObjectId = await resolveLocatorObject(actionClient, targetLocator, contextId);
        if (!targetObjectId) throw new Error("Target locator matched no element for drag_to.");
        try {
          await dispatchLocatorDrag(actionClient, objectId, targetObjectId);
        } finally {
          await actionClient.send("Runtime.releaseObject", { objectId: targetObjectId }).catch(() => ({}));
        }
      } else if (action === "press_key") {
        const point = await locatorObjectCenter(actionClient, objectId);
        await actionClient.send("DOM.focus", { backendNodeId: point.backendNodeId });
        await dispatchLocatorKey(actionClient, step.key);
        value = String(step.key ?? "");
      } else if (action === "scroll_into_view") {
        await callLocatorObject(actionClient, objectId, "function(){this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});}");
      } else if (action === "scroll") {
        await callLocatorObject(actionClient, objectId, "function(){this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});}");
        const point = await locatorObjectCenter(actionClient, objectId);
        const horizontal = ["left", "right"].includes(step.direction);
        const sign = ["up", "left"].includes(step.direction) ? -1 : 1;
        const amount = Math.max(1, Math.min(Number(step.pages) || 1, 100)) * 640;
        await actionClient.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: horizontal ? sign * amount : 0, deltaY: horizontal ? 0 : sign * amount });
      } else if (action === "get_attribute") {
        if (!step.attribute) throw new Error("get_attribute requires attribute.");
        value = await callLocatorObject(actionClient, objectId, "function(name){return this.getAttribute(name);}", [String(step.attribute)]);
        value = value == null ? null : String(value);
      } else throw new Error(`Unsupported locator action: ${action}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const element = await locatorObjectSummary(actionClient, objectId).catch(() => null);
      return { action, matched: true, value, element, matches: element ? [element] : [] };
    } finally {
      await actionClient.send("Runtime.releaseObject", { objectId }).catch(() => ({}));
    }
  } finally {
    await scope.cleanup();
  }
}

export async function browserSessionLocator({ name, targetId, targetClaim: claim = "", steps = [] } = {}) {
  const normalized = normalizeSessionName(name);
  const session = await describeBrowserSession(normalized);
  if (!session.running || !session.endpoint) throw new Error(`Browser session ${normalized} is not running.`);
  if (!targetId) throw new Error("Browser locator requires an exact targetId.");
  const monitor = await ensureTargetMonitor(session, targetId, claim, true);
  const selectedSteps = Array.isArray(steps) ? steps.slice(0, 20) : [];
  if (!selectedSteps.length) throw new Error("Browser locator requires at least one step.");
  const results = [];
  const binding = { session: normalized, targetId: String(targetId), targetClaim: String(claim) };
  for (const step of selectedSteps) results.push(await performLocatorStep(monitor.client, step, normalized, binding));
  const screenshotResult = await monitor.client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }).catch(() => null);
  const described = await describeBrowserSession(normalized);
  const target = described.targets.find((item) => item.id === String(targetId)) ?? null;
  return {
    session: described,
    target,
    results,
    screenshot: screenshotResult?.data ? { data: String(screenshotResult.data), mimeType: "image/png" } : null,
  };
}

export async function browserSessionSnapshot({ name, targetId, targetClaim: claim = "", maxNodes = 500, includeText = true } = {}) {
  const normalized = normalizeSessionName(name);
  const session = await describeBrowserSession(normalized);
  if (!session.running || !session.endpoint) throw new Error(`Browser session ${normalized} is not running.`);
  if (!targetId) throw new Error("Browser snapshot requires an exact targetId.");
  const monitor = await ensureTargetMonitor(session, targetId, claim, true);
  await monitor.client.send("Accessibility.enable").catch(() => ({}));
  const tree = await monitor.client.send("Accessibility.getFullAXTree", {});
  const compact = buildCompactAxSnapshot(tree.nodes, { maxNodes, includeText });
  const snapshotId = createHash("sha256")
    .update(`${normalized}\0${targetId}\0${claim}\0${Date.now()}\0${Math.random()}`)
    .digest("hex")
    .slice(0, 32);
  const expiresAt = Date.now() + BROWSER_REF_TTL_MS;
  BROWSER_REF_SNAPSHOTS.set(snapshotId, {
    session: normalized,
    targetId: String(targetId),
    targetClaim: String(claim),
    expiresAt,
    refs: new Map(compact.refs.map((entry) => [entry.ref, entry])),
  });
  cleanupBrowserRefSnapshots();
  const described = await describeBrowserSession(normalized);
  const target = described.targets.find((item) => item.id === String(targetId)) ?? null;
  return {
    session: described,
    target,
    snapshotId,
    expiresInMs: BROWSER_REF_TTL_MS,
    content: compact.content,
    refs: compact.refs.map(({ backendNodeId: _private, ...entry }) => entry),
    nodeCount: compact.nodeCount,
    truncated: compact.truncated,
  };
}
