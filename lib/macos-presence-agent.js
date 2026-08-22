import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import WebSocket from "ws";

const HEARTBEAT_MS = 20_000;
const SESSION_POLL_MS = 2_000;
const MAX_RECONNECT_MS = 30_000;
const REGISTRATION_TIMEOUT_MS = 15_000;

const presenceTool = {
  name: "device_presence",
  title: "Device pre-login presence",
  description: "Read-only health state published by the macOS boot service before the user's desktop session is available.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["online"] },
      mode: { type: "string", enum: ["prelogin"] },
      hostname: { type: "string" },
      consoleUser: { type: "string" },
      uptimeSeconds: { type: "number" },
    },
    required: ["status", "mode", "hostname", "consoleUser", "uptimeSeconds"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
};

function consoleUser() {
  try {
    return execFileSync("/usr/bin/stat", ["-f", "%Su", "/dev/console"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "loginwindow";
  } catch {
    return "unknown";
  }
}

function presenceConfig() {
  const gatewayUrl = String(process.env.DEVICE_GATEWAY_URL ?? "");
  const gatewayToken = String(process.env.DEVICE_GATEWAY_TOKEN ?? "");
  if (!/^wss?:\/\//u.test(gatewayUrl)) throw new Error("DEVICE_GATEWAY_URL must use ws:// or wss://.");
  if (gatewayToken.length < 32) throw new Error("Pre-login presence requires DEVICE_GATEWAY_TOKEN in the local environment file.");
  const desktopUser = String(process.env.PRESENCE_DESKTOP_USER || process.env.USER || "").trim();
  if (!desktopUser) throw new Error("PRESENCE_DESKTOP_USER is required.");
  return {
    gatewayUrl,
    gatewayToken,
    desktopUser,
    deviceId: process.env.DEVICE_ID ?? hostname().replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 128),
    deviceName: process.env.DEVICE_NAME ?? hostname(),
    ipFamily: [4, 6].includes(Number(process.env.DEVICE_GATEWAY_IP_FAMILY)) ? Number(process.env.DEVICE_GATEWAY_IP_FAMILY) : 0,
  };
}

function presenceResult() {
  const structuredContent = {
    status: "online",
    mode: "prelogin",
    hostname: hostname(),
    consoleUser: consoleUser(),
    uptimeSeconds: Math.max(0, Math.round(process.uptime())),
  };
  return {
    content: [{ type: "text", text: `Device ${structuredContent.hostname} is online in pre-login mode.` }],
    structuredContent,
  };
}

export function startMacPresenceAgent() {
  if (process.platform !== "darwin") throw new Error("Pre-login presence is supported only on macOS.");
  const config = presenceConfig();
  let stopped = false;
  let activeSocket = null;
  let reconnectTimer = null;
  let reconnectMs = 1_000;

  const desktopIsActive = () => process.env.CHATGPT_PRESENCE_FORCE !== "1" && consoleUser() === config.desktopUser;

  const connect = () => {
    if (stopped || desktopIsActive() || activeSocket) return;
    const socket = new WebSocket(config.gatewayUrl, {
      headers: { Authorization: `Bearer ${config.gatewayToken}` },
      ...(config.ipFamily ? { family: config.ipFamily } : {}),
    });
    activeSocket = socket;
    let heartbeatTimer = null;
    let registrationTimer = null;
    let awaitingPong = false;
    let reconnectScheduled = false;

    socket.on("open", () => {
      reconnectMs = 1_000;
      socket.send(JSON.stringify({
        type: "register",
        deviceId: config.deviceId,
        name: `${config.deviceName} (pre-login)`,
        platform: "darwin",
        capabilities: [presenceTool.name],
        tools: [presenceTool],
      }));
      registrationTimer = setTimeout(() => socket.terminate(), REGISTRATION_TIMEOUT_MS);
      registrationTimer.unref();
      heartbeatTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (desktopIsActive()) {
          socket.close(1000, "desktop session active");
          return;
        }
        if (awaitingPong) {
          socket.terminate();
          return;
        }
        awaitingPong = true;
        socket.ping();
        socket.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
      }, HEARTBEAT_MS);
      heartbeatTimer.unref();
      console.log(`Pre-login presence connected to ${new URL(config.gatewayUrl).host} as ${config.deviceId}.`);
    });

    socket.on("pong", () => { awaitingPong = false; });
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (message.type === "registered") {
        if (registrationTimer) clearTimeout(registrationTimer);
        registrationTimer = null;
        return;
      }
      if (message.type !== "call" || !message.requestId) return;
      if (message.toolName !== presenceTool.name) {
        socket.send(JSON.stringify({ type: "result", requestId: message.requestId, ok: false, error: `Pre-login mode does not expose ${message.toolName}.` }));
        return;
      }
      socket.send(JSON.stringify({ type: "result", requestId: message.requestId, ok: true, result: presenceResult() }));
    });

    const scheduleReconnect = () => {
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (registrationTimer) clearTimeout(registrationTimer);
      if (activeSocket === socket) activeSocket = null;
      if (stopped || desktopIsActive()) return;
      const delay = reconnectMs;
      reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      reconnectTimer.unref();
    };
    socket.once("close", scheduleReconnect);
    socket.once("error", (error) => {
      console.error(`Pre-login presence connection failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.terminate();
    });
  };

  const sessionTimer = setInterval(() => {
    if (desktopIsActive()) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (activeSocket) activeSocket.close(1000, "desktop session active");
    } else {
      connect();
    }
  }, SESSION_POLL_MS);
  connect();

  return {
    stop() {
      stopped = true;
      clearInterval(sessionTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeSocket) activeSocket.close(1000, "presence agent stopped");
    },
  };
}
