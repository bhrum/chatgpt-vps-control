import { EventEmitter } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { platform } from "node:os";
import { browserExtensionPaths } from "./browser-extension-paths.js";

const connections = new Map();
let server = null;
let startPromise = null;

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(connection, message) {
  if (!connection.socket.destroyed) connection.socket.write(`${JSON.stringify(message)}\n`);
}

function discard(connection, reason = new Error("Browser extension disconnected.")) {
  if (connection.instanceId && connections.get(connection.instanceId) === connection) connections.delete(connection.instanceId);
  for (const pending of connection.pending.values()) pending.reject(reason);
  connection.pending.clear();
  connection.events.removeAllListeners();
}

function acceptSocket(socket, secret) {
  const connection = { socket, instanceId: "", generation: "", browser: "Chrome", tabs: [], pending: new Map(), events: new EventEmitter(), buffer: "", lastSeenAt: Date.now() };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    connection.buffer += chunk;
    while (connection.buffer.includes("\n")) {
      const index = connection.buffer.indexOf("\n");
      const line = connection.buffer.slice(0, index);
      connection.buffer = connection.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!connection.instanceId) {
        if (message.type !== "hello" || !safeEqual(message.secret, secret) || !/^[A-Za-z0-9._-]{8,128}$/.test(String(message.instanceId ?? ""))) {
          socket.destroy();
          return;
        }
        connection.instanceId = String(message.instanceId);
        connection.generation = /^[A-Za-z0-9._-]{8,128}$/.test(String(message.generation ?? "")) ? String(message.generation) : "legacy";
        connection.browser = String(message.browser ?? "Chrome").slice(0, 200);
        connection.tabs = Array.isArray(message.tabs) ? message.tabs : [];
        const previous = connections.get(connection.instanceId);
        if (previous && previous !== connection) previous.socket.destroy();
        connections.set(connection.instanceId, connection);
        send(connection, { type: "hello_ack" });
        continue;
      }
      connection.lastSeenAt = Date.now();
      if (message.type === "tabs") connection.tabs = Array.isArray(message.tabs) ? message.tabs : [];
      else if (message.type === "heartbeat") send(connection, { type: "heartbeat_ack", timestamp: Date.now() });
      else if (message.type === "response") {
        const pending = connection.pending.get(String(message.requestId));
        if (pending) {
          connection.pending.delete(String(message.requestId));
          if (message.ok === false) pending.reject(new Error(String(message.error ?? "Browser extension request failed.")));
          else pending.resolve(message.result);
        }
      } else if (message.type === "cdp_event") {
        connection.events.emit(`${message.targetId}:${message.method}`, message.params ?? {});
      }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => discard(connection));
}

async function socketIsListening(path) {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

export async function startBrowserExtensionBridge() {
  if (server) return server;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const paths = browserExtensionPaths();
    const secret = (await readFile(paths.secret, "utf8").catch(() => "")).trim();
    if (!secret) return null;
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    if (platform() !== "win32") {
      const info = await stat(paths.socket).catch(() => null);
      if (info?.isSocket()) {
        if (await socketIsListening(paths.socket)) throw new Error("Another ChatGPT Computer Control browser bridge is already running for this user.");
        await rm(paths.socket, { force: true });
      }
      else if (info) throw new Error(`Browser extension IPC path is not a socket: ${paths.socket}`);
    }
    const created = createServer((socket) => acceptSocket(socket, secret));
    await new Promise((resolve, reject) => {
      created.once("error", reject);
      created.listen(paths.socket, () => { created.off("error", reject); resolve(); });
    });
    if (platform() !== "win32") await chmod(paths.socket, 0o600);
    created.unref();
    created.on("close", () => { if (server === created) server = null; });
    server = created;
    return created;
  })().finally(() => { startPromise = null; });
  return startPromise;
}

export function listBrowserExtensionConnections() {
  return [...connections.values()].map((connection) => ({
    instanceId: connection.instanceId,
    generation: connection.generation,
    browser: connection.browser,
    tabs: connection.tabs.map((tab) => ({ ...tab })),
  }));
}

export async function browserExtensionRequest(instanceId, command, params = {}, timeoutMs = 10_000) {
  await startBrowserExtensionBridge();
  const connection = connections.get(String(instanceId));
  if (!connection) throw new Error("The selected browser extension is not connected.");
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(requestId);
      reject(new Error(`Browser extension request timed out: ${command}`));
    }, Math.max(250, Math.min(Number(timeoutMs) || 10_000, 60_000)));
    connection.pending.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    send(connection, { type: "request", requestId, command, params });
  });
}

export class ExtensionCdpClient {
  constructor(instanceId, targetId) {
    this.instanceId = instanceId;
    this.targetId = String(targetId);
    this.listeners = new Map();
    this.closed = false;
    this.socket = { readyState: 1 };
    const connection = connections.get(instanceId);
    if (!connection) throw new Error("The selected browser extension is not connected.");
    this.connection = connection;
  }

  on(method, listener) {
    const key = `${this.targetId}:${method}`;
    const wrapped = (params) => listener(params);
    this.connection.events.on(key, wrapped);
    this.listeners.set(listener, { key, wrapped });
    return this;
  }

  async send(method, params = {}) {
    return this.sendSession("", method, params);
  }

  async sendSession(sessionId, method, params = {}) {
    if (this.closed) throw new Error("Browser extension CDP client is closed.");
    return browserExtensionRequest(this.instanceId, "cdp", {
      targetId: this.targetId,
      ...(sessionId ? { sessionId: String(sessionId) } : {}),
      method,
      params,
    });
  }

  async attachFrameTarget(frameTargetId, parentSessionId = "") {
    if (this.closed) throw new Error("Browser extension CDP client is closed.");
    return browserExtensionRequest(this.instanceId, "cdp_auto_attach_frame", {
      targetId: this.targetId,
      frameTargetId: String(frameTargetId),
      ...(parentSessionId ? { parentSessionId: String(parentSessionId) } : {}),
    }, 5_000);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.readyState = 3;
    for (const { key, wrapped } of this.listeners.values()) this.connection.events.off(key, wrapped);
    this.listeners.clear();
    browserExtensionRequest(this.instanceId, "detach", { targetId: this.targetId }, 2_000).catch(() => {});
  }
}

export async function stopBrowserExtensionBridgeForTests() {
  for (const connection of connections.values()) connection.socket.destroy();
  connections.clear();
  if (!server) return;
  const current = server;
  await new Promise((resolve) => current.close(resolve));
  server = null;
  if (platform() !== "win32") await rm(browserExtensionPaths().socket, { force: true });
}
