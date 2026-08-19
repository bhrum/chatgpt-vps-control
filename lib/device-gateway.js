import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { WebSocketServer } from "ws";
import { z } from "zod";

const DEFAULT_AGENT_PATH = "/agent";
const DEFAULT_CALL_TIMEOUT_SECONDS = 120;
const MAX_CALL_TIMEOUT_SECONDS = 600;
const MAX_ARGUMENTS_JSON_CHARS = 20 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const STALE_AFTER_MS = 70_000;
const MAX_TOOL_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_TOOL_CATALOG_BYTES = 512 * 1024;

const devices = new Map();
const pendingCalls = new Map();
let gatewayAttached = false;

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = String(req.headers.authorization ?? "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function publicToolDescriptor(tool) {
  const name = String(tool?.name ?? "");
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(name) || name === "secure_input_submit") return null;
  const descriptor = {
    name,
    ...(tool.title ? { title: String(tool.title).slice(0, 300) } : {}),
    ...(tool.description ? { description: String(tool.description).slice(0, 12_000) } : {}),
    ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema && typeof tool.outputSchema === "object" ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations && typeof tool.annotations === "object" ? { annotations: tool.annotations } : {}),
  };
  return Buffer.byteLength(JSON.stringify(descriptor)) <= MAX_TOOL_DESCRIPTOR_BYTES ? descriptor : null;
}

function normalizeToolCatalog(tools, capabilities) {
  const allowed = new Set((Array.isArray(capabilities) ? capabilities : []).map(String));
  const result = [];
  let totalBytes = 0;
  for (const raw of Array.isArray(tools) ? tools.slice(0, 100) : []) {
    const descriptor = publicToolDescriptor(raw);
    if (!descriptor || !allowed.has(descriptor.name)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(descriptor));
    if (totalBytes + bytes > MAX_TOOL_CATALOG_BYTES) break;
    totalBytes += bytes;
    result.push(descriptor);
  }
  return result;
}

function toolCatalogVersion(tools) {
  return tools.length ? createHash("sha256").update(JSON.stringify(tools)).digest("hex") : "";
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    status: device.status,
    lastSeen: new Date(device.lastSeen).toISOString(),
    capabilities: device.capabilities,
    toolSchemaCount: Array.isArray(device.tools) ? device.tools.length : 0,
    toolSchemaVersion: device.toolSchemaVersion || "",
  };
}

function markDisconnected(socket) {
  for (const device of devices.values()) {
    if (device.socket !== socket) continue;
    device.status = "offline";
    device.socket = null;
    device.lastSeen = Date.now();
  }
}

function rejectSocket(socket, code, reason) {
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
  }
}

function handleAgentMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    rejectSocket(socket, 1007, "invalid JSON");
    return;
  }

  if (message.type === "register") {
    const id = String(message.deviceId ?? "").trim();
    const name = String(message.name ?? id).trim();
    const platform = String(message.platform ?? "unknown").trim();
    const capabilities = Array.isArray(message.capabilities)
      ? [...new Set(message.capabilities.map(String))].slice(0, 100)
      : [];
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id) || !name || name.length > 200) {
      rejectSocket(socket, 1008, "invalid device registration");
      return;
    }

    const tools = normalizeToolCatalog(message.tools, capabilities);
    const toolSchemaVersion = toolCatalogVersion(tools);
    const previous = devices.get(id);
    if (previous?.socket && previous.socket !== socket) {
      rejectSocket(previous.socket, 4001, "device reconnected");
    }
    devices.set(id, {
      id,
      name,
      platform,
      capabilities,
      tools,
      toolSchemaVersion,
      status: "online",
      lastSeen: Date.now(),
      socket,
    });
    socket.deviceId = id;
    socket.send(JSON.stringify({ type: "registered", deviceId: id }));
    return;
  }

  if (message.type === "heartbeat") {
    const device = devices.get(socket.deviceId);
    if (device) {
      device.lastSeen = Date.now();
      device.status = "online";
    }
    return;
  }

  if (message.type === "result") {
    const pending = pendingCalls.get(String(message.requestId ?? ""));
    if (!pending || pending.deviceId !== socket.deviceId) return;
    pendingCalls.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }
}

export function attachDeviceGateway(httpServer, options = {}) {
  if (gatewayAttached) return;
  const token = String(options.token ?? process.env.DEVICE_GATEWAY_TOKEN ?? "");
  if (token.length < 32) return;
  gatewayAttached = true;

  const path = options.path ?? process.env.DEVICE_GATEWAY_PATH ?? DEFAULT_AGENT_PATH;
  const centralId = options.centralId ?? process.env.DEVICE_CENTRAL_ID ?? hostname();
  const centralName = options.centralName ?? process.env.DEVICE_CENTRAL_NAME ?? centralId;
  const centralTools = normalizeToolCatalog(options.centralTools, options.centralCapabilities);
  devices.set(centralId, {
    id: centralId,
    name: centralName,
    platform: process.platform,
    capabilities: options.centralCapabilities ?? ["vps_status", "run_shell_command", "write_text_file", "recent_commands"],
    tools: centralTools,
    toolSchemaVersion: toolCatalogVersion(centralTools),
    status: "online",
    lastSeen: Date.now(),
    socket: null,
    central: true,
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RESULT_BYTES });
  httpServer.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== path) return;
    if (!safeEqual(bearerToken(req), token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket) => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
      const device = devices.get(socket.deviceId);
      if (device) device.lastSeen = Date.now();
    });
    socket.on("message", (raw) => handleAgentMessage(socket, raw));
    socket.on("close", () => markDisconnected(socket));
    socket.on("error", () => markDisconnected(socket));
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    for (const device of devices.values()) {
      if (!device.central && now - device.lastSeen > STALE_AFTER_MS) device.status = "offline";
    }
  }, 25_000);
  heartbeatTimer.unref();
}

export function listRegisteredDevices() {
  return [...devices.values()]
    .map(publicDevice)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function describeRegisteredDeviceTool(deviceId, toolName) {
  const device = devices.get(deviceId);
  if (!device) throw new Error(`Unknown device: ${deviceId}. Call list_devices first.`);
  const tool = Array.isArray(device.tools) ? device.tools.find((entry) => entry.name === toolName) ?? null : null;
  return {
    deviceId,
    toolName,
    available: Boolean(tool),
    schemaVersion: device.toolSchemaVersion || "",
    tool,
    message: tool
      ? `Returned the current schema for ${toolName} on ${deviceId}.`
      : `No schema is registered for ${toolName} on ${deviceId}.`,
  };
}

export async function callRegisteredDevice(deviceId, toolName, args, timeoutSeconds = DEFAULT_CALL_TIMEOUT_SECONDS) {
  const device = devices.get(deviceId);
  if (!device) throw new Error(`Unknown device: ${deviceId}. Call list_devices first.`);
  if (device.central) throw new Error(`Device ${deviceId} is the central server; use its existing MCP tools directly.`);
  if (device.status !== "online" || !device.socket || device.socket.readyState !== 1) {
    throw new Error(`Device ${deviceId} is offline.`);
  }
  if (!device.capabilities.includes(toolName)) {
    throw new Error(`Device ${deviceId} does not expose tool ${toolName}.`);
  }

  const requestId = randomBytes(16).toString("hex");
  const timeoutMs = Math.min(Math.max(Number(timeoutSeconds) || DEFAULT_CALL_TIMEOUT_SECONDS, 1), MAX_CALL_TIMEOUT_SECONDS) * 1000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(requestId);
      reject(new Error(`Device call timed out after ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
    pendingCalls.set(requestId, { deviceId, resolve, reject, timer });
    device.socket.send(JSON.stringify({ type: "call", requestId, toolName, arguments: args }), (error) => {
      if (!error) return;
      pendingCalls.delete(requestId);
      clearTimeout(timer);
      reject(error);
    });
  });
}

const deviceShape = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  status: z.enum(["online", "offline"]),
  lastSeen: z.string(),
  capabilities: z.array(z.string()),
  toolSchemaCount: z.number().int().nonnegative(),
  toolSchemaVersion: z.string(),
});

const toolDescriptorShape = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  annotations: z.unknown().optional(),
});

const describeDeviceToolShape = {
  deviceId: z.string(),
  toolName: z.string(),
  available: z.boolean(),
  schemaVersion: z.string(),
  tool: toolDescriptorShape.nullable(),
  message: z.string(),
};

export const deviceToolOutputShape = {
  deviceId: z.string(),
  toolName: z.string(),
  status: z.enum(["completed", "failed"]),
  resultJson: z.string(),
};

export function registerDeviceTools(server, options = {}) {
  const canRead = options.canRead ?? (() => true);
  const canWrite = options.canWrite ?? (() => true);
  const readAuthError = options.readAuthError ?? (() => ({ isError: true, content: [{ type: "text", text: "Read authorization required." }] }));
  const writeAuthError = options.writeAuthError ?? (() => ({ isError: true, content: [{ type: "text", text: "Write authorization required." }] }));
  const readSecuritySchemes = options.readSecuritySchemes ?? [{ type: "noauth" }];
  const writeSecuritySchemes = options.writeSecuritySchemes ?? [{ type: "oauth2", scopes: ["vps.write"] }];

  server.registerTool(
    "list_devices",
    {
      title: "List controllable devices",
      description: "Return the live registry of central and dynamically connected computers. Call this before selecting a device.",
      inputSchema: {},
      outputSchema: { devices: z.array(deviceShape) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    async () => {
      if (!canRead()) return readAuthError();
      const result = { devices: listRegisteredDevices() };
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "describe_device_tool",
    {
      title: "Describe a device tool",
      description: "Return the latest MCP title, description, input schema, output schema, and annotations for one tool advertised by a selected device.",
      inputSchema: { deviceId: z.string().min(1).max(128), toolName: z.string().min(1).max(128) },
      outputSchema: describeDeviceToolShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    async ({ deviceId, toolName }) => {
      if (!canRead()) return readAuthError();
      const result = describeRegisteredDeviceTool(deviceId, toolName);
      return { structuredContent: result, content: [{ type: "text", text: result.message }] };
    }
  );

  server.registerTool(
    "device_call",
    {
      title: "Call a tool on a device",
      description: "Call one advertised MCP tool on a dynamically connected device. Obtain deviceId and toolName from list_devices; use describe_device_tool when the schema is unfamiliar or may have changed; argumentsJson must be a JSON object.",
      inputSchema: {
        deviceId: z.string().min(1).max(128),
        toolName: z.string().min(1).max(128),
        argumentsJson: z.string().max(MAX_ARGUMENTS_JSON_CHARS).default("{}"),
        timeoutSeconds: z.number().int().min(1).max(MAX_CALL_TIMEOUT_SECONDS).optional(),
      },
      outputSchema: deviceToolOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      securitySchemes: writeSecuritySchemes,
    },
    async ({ deviceId, toolName, argumentsJson, timeoutSeconds }) => {
      if (!canWrite()) return writeAuthError();
      let args;
      try {
        args = JSON.parse(argumentsJson || "{}");
        if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("not an object");
      } catch (error) {
        const result = { deviceId, toolName, status: "failed", resultJson: JSON.stringify({ error: `Invalid argumentsJson: ${error.message}` }) };
        return { isError: true, structuredContent: result, content: [{ type: "text", text: result.resultJson }] };
      }

      try {
        const response = await callRegisteredDevice(deviceId, toolName, args, timeoutSeconds);
        const result = {
          deviceId,
          toolName,
          status: response.ok === false ? "failed" : "completed",
          resultJson: JSON.stringify(response.result?.structuredContent ?? response.result ?? { error: response.error }),
        };
        const content = Array.isArray(response.result?.content) ? response.result.content : [{ type: "text", text: result.resultJson }];
        return { isError: response.ok === false, structuredContent: result, content };
      } catch (error) {
        const result = { deviceId, toolName, status: "failed", resultJson: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) };
        return { isError: true, structuredContent: result, content: [{ type: "text", text: result.resultJson }] };
      }
    }
  );
}

export function buildDeviceToolDescriptors(options = {}) {
  const readSecuritySchemes = options.readSecuritySchemes ?? [{ type: "noauth" }];
  const writeSecuritySchemes = options.writeSecuritySchemes ?? [{ type: "oauth2", scopes: ["vps.write"] }];
  return [
    {
      name: "list_devices",
      title: "List controllable devices",
      description: "Return the live registry of central and dynamically connected computers. Call this before selecting a device.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          devices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, name: { type: "string" }, platform: { type: "string" },
                status: { type: "string", enum: ["online", "offline"] }, lastSeen: { type: "string" },
                capabilities: { type: "array", items: { type: "string" } },
                toolSchemaCount: { type: "integer", minimum: 0 }, toolSchemaVersion: { type: "string" },
              },
              required: ["id", "name", "platform", "status", "lastSeen", "capabilities", "toolSchemaCount", "toolSchemaVersion"],
              additionalProperties: false,
            },
          },
        },
        required: ["devices"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    {
      name: "describe_device_tool",
      title: "Describe a device tool",
      description: "Return the latest MCP title, description, input schema, output schema, and annotations for one tool advertised by a selected device.",
      inputSchema: {
        type: "object",
        properties: { deviceId: { type: "string", minLength: 1, maxLength: 128 }, toolName: { type: "string", minLength: 1, maxLength: 128 } },
        required: ["deviceId", "toolName"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" }, toolName: { type: "string" }, available: { type: "boolean" }, schemaVersion: { type: "string" },
          tool: { type: ["object", "null"] }, message: { type: "string" },
        },
        required: ["deviceId", "toolName", "available", "schemaVersion", "tool", "message"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    {
      name: "device_call",
      title: "Call a tool on a device",
      description: "Call one advertised MCP tool on a dynamically connected device. Obtain deviceId and toolName from list_devices; use describe_device_tool when the schema is unfamiliar or may have changed; argumentsJson must be a JSON object.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", minLength: 1, maxLength: 128 },
          toolName: { type: "string", minLength: 1, maxLength: 128 },
          argumentsJson: { type: "string", maxLength: MAX_ARGUMENTS_JSON_CHARS, default: "{}" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_CALL_TIMEOUT_SECONDS },
        },
        required: ["deviceId", "toolName"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" }, toolName: { type: "string" },
          status: { type: "string", enum: ["completed", "failed"] }, resultJson: { type: "string" },
        },
        required: ["deviceId", "toolName", "status", "resultJson"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      securitySchemes: writeSecuritySchemes,
    },
  ];
}
