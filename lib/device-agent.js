import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname, platform } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { createSecureInputChannel, resolveSensitiveTemplate } from "./secure-input.js";

const HEARTBEAT_MS = 20_000;
const MAX_RECONNECT_MS = 30_000;
const MAX_TOOL_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_TOOL_CATALOG_BYTES = 512 * 1024;
const REGISTRATION_TIMEOUT_MS = 15_000;

function publicToolDescriptor(tool) {
  const name = String(tool?.name || "");
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(name)) return null;
  const descriptor = {
    name,
    ...(tool.title ? { title: String(tool.title).slice(0, 300) } : {}),
    ...(tool.description ? { description: String(tool.description).slice(0, 12_000) } : {}),
    ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema && typeof tool.outputSchema === "object" ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations && typeof tool.annotations === "object" ? { annotations: tool.annotations } : {}),
  };
  const encoded = JSON.stringify(descriptor);
  return Buffer.byteLength(encoded) <= MAX_TOOL_DESCRIPTOR_BYTES ? descriptor : null;
}

function buildToolCatalog(tools) {
  const result = [];
  let totalBytes = 0;
  for (const tool of Array.isArray(tools) ? tools : []) {
    const descriptor = publicToolDescriptor(tool);
    if (!descriptor) continue;
    const bytes = Buffer.byteLength(JSON.stringify(descriptor));
    if (totalBytes + bytes > MAX_TOOL_CATALOG_BYTES) break;
    totalBytes += bytes;
    result.push(descriptor);
  }
  return result;
}

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
      if (gatewayToken.length < 32) {
        throw new Error("Unable to read the device gateway token from macOS Keychain and no valid fallback token is configured.");
      }
      console.warn("Unable to read the device gateway token from macOS Keychain; using the configured fallback token.");
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
  const toolDescriptors = buildToolCatalog(listed.tools);
  const capabilities = listed.tools.map((tool) => tool.name);
  const toolSchemaVersion = createHash("sha256").update(JSON.stringify(toolDescriptors)).digest("hex");
  return { client, transport, capabilities, toolDescriptors, toolSchemaVersion };
}

async function runSecureInput(local, secureChannel, args) {
  const challengeId = String(args?.challengeId || "");
  if (!/^[a-f0-9-]{16,64}$/u.test(challengeId)) throw new Error("Invalid sensitive-input challenge.");
  const steps = Array.isArray(args?.steps) ? args.steps : [];
  if (!steps.length || steps.length > 10) throw new Error("Sensitive-input steps are invalid.");
  const values = await secureChannel.decrypt(args.envelope, challengeId);
  let completedSteps = 0;
  for (const step of steps) {
    const toolName = String(step?.toolName || "");
    if (!local.capabilities.includes(toolName) || toolName === "secure_input_submit") throw new Error(`Sensitive-input target tool ${toolName} is unavailable.`);
    const result = await local.client.callTool({
      name: toolName,
      arguments: resolveSensitiveTemplate(step.arguments || {}, values),
    });
    if (result.isError) throw new Error(`Sensitive-input step ${completedSteps + 1} failed.`);
    completedSteps += 1;
  }
  return {
    content: [{ type: "text", text: `Sensitive input completed on the device (${completedSteps} step${completedSteps === 1 ? "" : "s"}).` }],
    structuredContent: { challengeId, status: "completed", completedSteps },
  };
}

export function startDeviceAgent() {
  const config = requiredConfig();
  if (!config) return null;
  let stopped = false;
  let reconnectMs = 1_000;
  let local = null;
  let secureChannel = null;
  let activeSocket = null;
  let reconnectTimer = null;

  const connect = async () => {
    if (stopped) return;
    try {
      if (!local) local = await openLocalClient(config);
      if (!secureChannel) secureChannel = await createSecureInputChannel();
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
          name: config.deviceName,
          platform: platform(),
          capabilities: [...local.capabilities, "secure_input_submit"],
          tools: local.toolDescriptors,
          toolSchemaVersion: local.toolSchemaVersion,
          secureInputPublicKey: secureChannel.publicKey,
        }));
        registrationTimer = setTimeout(() => {
          console.error("Device gateway registration timed out; reconnecting.");
          socket.terminate();
        }, REGISTRATION_TIMEOUT_MS);
        registrationTimer.unref();
        heartbeatTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (awaitingPong) {
            console.error("Device gateway heartbeat timed out; reconnecting.");
            socket.terminate();
            return;
          }
          awaitingPong = true;
          socket.ping();
          socket.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
        }, HEARTBEAT_MS);
        heartbeatTimer.unref();
        console.log(`Device agent connected to ${new URL(config.gatewayUrl).host} as ${config.deviceId}.`);
      });

      socket.on("pong", () => {
        awaitingPong = false;
      });

      socket.on("message", async (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (message.type === "registered") {
          if (registrationTimer) clearTimeout(registrationTimer);
          registrationTimer = null;
          return;
        }
        if (message.type !== "call" || !message.requestId || !message.toolName) return;
        try {
          const result = message.toolName === "secure_input_submit"
            ? await runSecureInput(local, secureChannel, message.arguments ?? {})
            : await local.client.callTool({ name: message.toolName, arguments: message.arguments ?? {} });
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
        if (reconnectScheduled) return;
        reconnectScheduled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (registrationTimer) clearTimeout(registrationTimer);
        if (activeSocket === socket) activeSocket = null;
        if (stopped) return;
        const delay = reconnectMs;
        reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connect();
        }, delay);
        reconnectTimer.unref();
      };
      socket.once("close", scheduleReconnect);
      socket.once("error", () => socket.terminate());
    } catch (error) {
      console.error(`Device agent connection failed: ${error instanceof Error ? error.message : String(error)}`);
      if (local) {
        await local.client.close().catch(() => {});
        local = null;
      }
      const delay = reconnectMs;
      reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
      reconnectTimer.unref();
    }
  };

  void connect();
  return {
    stop: async () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeSocket) activeSocket.close(1000, "device agent stopped");
      if (local) await local.client.close().catch(() => {});
    },
  };
}
