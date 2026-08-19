import { spawn } from "node:child_process";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeComputerHelperPath } from "./native-computer-backend.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_LINE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 7_000;
let service = null;
let nextRequestId = 1;

export function decodeNativeObservationTarget(elementId) {
  if (typeof elementId !== "string" || elementId.length < 2 || elementId.length > 16_384) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(String(elementId), "base64url").toString("utf8")); }
  catch { return null; }
  if (payload?.source === "macos-ax" && Number.isInteger(payload.pid) && payload.pid > 0 && Array.isArray(payload.path)) {
    return { source: "macos-ax", target: String(payload.pid) };
  }
  const hwnd = Number(payload?.hwnd);
  if (payload?.source === "windows-uia" && Number.isSafeInteger(hwnd) && hwnd > 0 && Array.isArray(payload.path)) {
    return { source: "windows-uia", target: String(hwnd) };
  }
  if (payload?.source === "linux-atspi" && Array.isArray(payload.path) && Number.isInteger(payload.path[0]) && payload.path[0] >= 0) {
    return { source: "linux-atspi", target: String(payload.path[0]) };
  }
  return null;
}

function commandForCurrentPlatform() {
  if (platform() === "darwin") return [nativeComputerHelperPath(), ["--observer-server"]];
  if (platform() === "win32") {
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", nativeComputerHelperPath(), "--observer-server"]];
  }
  return ["python3", [join(rootDir, "native", "linux", "accessibility-helper.py"), "--observer-server"]];
}

class ObserverService {
  constructor() {
    const [command, args] = commandForCurrentPlatform();
    const env = platform() === "linux"
      ? { ...process.env, NO_AT_BRIDGE: "0", GTK_MODULES: process.env.GTK_MODULES || "gail:atk-bridge" }
      : process.env;
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.buffer = "";
    this.pending = new Map();
    this.watched = new Map();
    this.closed = false;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.on("error", (error) => this.close(error));
    this.child.on("close", () => this.close(new Error("Native event observer exited.")));
    this.child.stderr.resume();
    this.child.unref();
  }

  onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) return this.close(new Error("Native event observer response was too large."));
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response);
      else pending.reject(new Error(response.error || "Native event observer request failed."));
    }
  }

  request(command) {
    if (this.closed) return Promise.reject(new Error("Native event observer is closed."));
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Native event observer request timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  retainTarget(source, target) {
    const key = `${source}:${target}`;
    this.watched.delete(key);
    this.watched.set(key, { source, target });
    while (this.watched.size > 32) {
      const [oldestKey, oldest] = this.watched.entries().next().value;
      this.watched.delete(oldestKey);
      void this.request({ command: "unwatch", ...oldest }).catch(() => {});
    }
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (service === this) service = null;
  }
}

function currentService() {
  if (!service || service.closed) service = new ObserverService();
  return service;
}

export async function beginNativeEventObservation(elementId) {
  const decoded = decodeNativeObservationTarget(elementId);
  if (!decoded) return null;
  try {
    const activeService = currentService();
    const response = await activeService.request({ command: "watch", source: decoded.source, target: decoded.target });
    activeService.retainTarget(decoded.source, decoded.target);
    return { ...decoded, baseline: Number(response.generation ?? 0) };
  } catch { return null; }
}

export async function waitNativeEventObservation(observation) {
  if (!observation) return null;
  try {
    const response = await currentService().request({
      command: "wait", source: observation.source, target: observation.target,
      baseline: observation.baseline, minimumMs: 180, quietMs: 250, maximumMs: 5000,
    });
    return {
      settleDurationMs: Number(response.durationMs ?? 0),
      settleEventCount: Number(response.eventCount ?? 0),
      settleSource: String(response.source ?? "native-event-service"),
    };
  } catch { return null; }
}
