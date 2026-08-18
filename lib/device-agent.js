import { execFileSync } from "node:child_process";
import { hostname, platform } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

const HEARTBEAT_MS = 20_000;
const MAX_RECONNECT_MS = 30_000;

function requiredConfig() {
  const gatewayUrl = String(process.env.DEVICE_GATEWAY_URL ?? "");
  let gatewayToken = String(process.env.DEVICE_GATEWAY_TOKEN ?? "");
  if (platform() === "darwin" && process.env.DEVICE_GATEWAY_TOKEN_KEYCHAIN_SERVICE) {
    try {
      gatewayToken = execFileSync("security", [
        "find-generic-password",
        "-s",
        process.env.DEVICE_GATEWAY_TOKEN_KEYCHAIN_SERVICE,
        "-a",
        process.env.DEVICE_GATEWAY_TOKEN_KEYCHAIN_ACCOUNT || "device-gateway-token",
        "-w",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      throw new Error("Unable to read the device gateway token from macOS Keychain.");
    }
  }
  const localToken = String(process.env.VPS_APP_TOKEN ?? "");
  if (!gatewayUrl) return null;
  if (!/^wss?:\/\//.test(gatewayUrl)) throw new Error("DEVICE_GATEWAY_URL must use ws:// or wss://.");
  if (gatewayToken.length < 32) throw new Error("DEVICE_GATEWAY_TOKEN must be at least 32 characters.");
  if (localToken.length < 24) throw new Error("VPS_APP_TOKEN must be at least 24 characters.");
  return {
    gatewayUrl,
    gatewayToken,
    localToken,
    localUrl: process.env.DEVICE_LOCAL_MCP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}${process.env.MCP_PATH_PREFIX ?? "/mcp"}`,
    deviceId: process.env.DEVICE_ID ?? hostname().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128),
    deviceName: process.env.DEVICE_NAME ?? hostname(),
    ipFamily: [4, 6].includes(Number(process.env.DEVICE_GATEWAY_IP_FAMILY))
      ? Number(process.env.DEVICE_GATEWAY_IP_FAMILY)
      : 0,
  };
}

async function openLocalClient(config) {
  const transport = new StreamableHTTPClientTransport(new URL(config.localUrl), {
    requestInit: { headers: { Authorization: `Bearer ${config.localToken}` } },
  });
  const client = new Client({ name: "chatgpt-device-agent", version: "1.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  return { client, transport, capabilities: listed.tools.map((tool) => tool.name) };
}

export function startDeviceAgent() {
  const config = requiredConfig();
  if (!config) return null;
  let stopped = false;
  let reconnectMs = 1_000;
  let local = null;

  const connect = async () => {
    if (stopped) return;
    try {
      if (!local) local = await openLocalClient(config);
      const socket = new WebSocket(config.gatewayUrl, {
        headers: { Authorization: `Bearer ${config.gatewayToken}` },
        ...(config.ipFamily ? { family: config.ipFamily } : {}),
      });
      let heartbeatTimer = null;

      socket.on("open", () => {
        reconnectMs = 1_000;
        socket.send(JSON.stringify({
          type: "register",
          deviceId: config.deviceId,
          name: config.deviceName,
          platform: platform(),
          capabilities: local.capabilities,
        }));
        heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
        }, HEARTBEAT_MS);
        heartbeatTimer.unref();
        console.log(`Device agent connected to ${new URL(config.gatewayUrl).host} as ${config.deviceId}.`);
      });

      socket.on("message", async (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (message.type !== "call" || !message.requestId || !message.toolName) return;
        try {
          const result = await local.client.callTool({ name: message.toolName, arguments: message.arguments ?? {} });
          socket.send(JSON.stringify({ type: "result", requestId: message.requestId, ok: !result.isError, result }));
        } catch (error) {
          socket.send(JSON.stringify({
            type: "result",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });

      const scheduleReconnect = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (stopped) return;
        const delay = reconnectMs;
        reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
        setTimeout(connect, delay).unref();
      };
      socket.once("close", scheduleReconnect);
      socket.once("error", () => socket.close());
    } catch (error) {
      console.error(`Device agent connection failed: ${error instanceof Error ? error.message : String(error)}`);
      if (local) {
        await local.client.close().catch(() => {});
        local = null;
      }
      const delay = reconnectMs;
      reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
      setTimeout(connect, delay).unref();
    }
  };

  void connect();
  return {
    stop: async () => {
      stopped = true;
      if (local) await local.client.close().catch(() => {});
    },
  };
}
