const MAX_CALL_TIMEOUT_SECONDS = 600;
const DEFAULT_CALL_TIMEOUT_SECONDS = 120;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function validDeviceId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

function publicDevice(value) {
  return {
    id: String(value.id),
    name: String(value.name || value.id),
    platform: String(value.platform || "unknown"),
    status: value.status === "online" ? "online" : "offline",
    lastSeen: String(value.lastSeen || new Date(0).toISOString()),
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String).slice(0, 100) : [],
  };
}

const TOOLS = [
  {
    name: "list_devices",
    title: "List controllable devices",
    description: "List the computers currently registered with this MCP, including online status and the MCP tools each device supports. Call this before selecting a device.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        devices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              platform: { type: "string" },
              status: { type: "string", enum: ["online", "offline"] },
              lastSeen: { type: "string" },
              capabilities: { type: "array", items: { type: "string" } },
            },
            required: ["id", "name", "platform", "status", "lastSeen", "capabilities"],
            additionalProperties: false,
          },
        },
      },
      required: ["devices"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "device_call",
    title: "Call a tool on a device",
    description: "Call one advertised MCP tool on a selected online computer. Obtain deviceId and toolName from list_devices. Pass the target tool arguments as an object in arguments.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", minLength: 1, maxLength: 128 },
        toolName: { type: "string", minLength: 1, maxLength: 128 },
        arguments: { type: "object", additionalProperties: true },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_CALL_TIMEOUT_SECONDS },
      },
      required: ["deviceId", "toolName"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

export class DeviceRegistry {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ deviceId: null, registered: false });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/devices" && request.method === "GET") {
      return json({ devices: await this.listDevices() });
    }

    if (url.pathname === "/call" && request.method === "POST") {
      const body = await request.json();
      return json(await this.callDevice(body));
    }

    return new Response("Not found", { status: 404 });
  }

  async listDevices() {
    const saved = await this.ctx.storage.list({ prefix: "device:" });
    const devices = new Map();
    for (const value of saved.values()) devices.set(value.id, publicDevice({ ...value, status: "offline" }));

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (!attachment?.registered || !attachment.deviceId) continue;
      devices.set(attachment.deviceId, publicDevice({ ...attachment, id: attachment.deviceId, status: "online" }));
    }
    return [...devices.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  socketForDevice(deviceId) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.registered && attachment.deviceId === deviceId) return { socket, attachment };
    }
    return null;
  }

  async callDevice(body) {
    const deviceId = String(body?.deviceId || "");
    const toolName = String(body?.toolName || "");
    if (!validDeviceId(deviceId)) throw new Error("Invalid deviceId.");
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(toolName)) throw new Error("Invalid toolName.");
    const connection = this.socketForDevice(deviceId);
    if (!connection) throw new Error(`Device ${deviceId} is offline.`);
    if (!connection.attachment.capabilities?.includes(toolName)) throw new Error(`Device ${deviceId} does not expose ${toolName}.`);

    const requestId = crypto.randomUUID();
    const seconds = Math.min(Math.max(Number(body?.timeoutSeconds) || DEFAULT_CALL_TIMEOUT_SECONDS, 1), MAX_CALL_TIMEOUT_SECONDS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Device call timed out after ${seconds} seconds.`));
      }, seconds * 1000);
      this.pending.set(requestId, { deviceId, resolve, reject, timer });
      connection.socket.send(JSON.stringify({ type: "call", requestId, toolName, arguments: body?.arguments || {} }));
    });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== "string" && message.byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, "message too large");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      socket.close(1007, "invalid JSON");
      return;
    }

    if (payload.type === "register") {
      const deviceId = String(payload.deviceId || "");
      const name = String(payload.name || deviceId).slice(0, 200);
      if (!validDeviceId(deviceId) || !name) {
        socket.close(1008, "invalid registration");
        return;
      }
      for (const existing of this.ctx.getWebSockets()) {
        if (existing === socket) continue;
        if (existing.deserializeAttachment()?.deviceId === deviceId) existing.close(4001, "device reconnected");
      }
      const attachment = {
        deviceId,
        id: deviceId,
        name,
        platform: String(payload.platform || "unknown").slice(0, 100),
        capabilities: Array.isArray(payload.capabilities) ? [...new Set(payload.capabilities.map(String))].slice(0, 100) : [],
        registered: true,
        lastSeen: new Date().toISOString(),
      };
      socket.serializeAttachment(attachment);
      await this.ctx.storage.put(`device:${deviceId}`, publicDevice({ ...attachment, status: "online" }));
      socket.send(JSON.stringify({ type: "registered", deviceId }));
      return;
    }

    const attachment = socket.deserializeAttachment();
    if (!attachment?.registered) {
      socket.close(1008, "register first");
      return;
    }

    if (payload.type === "heartbeat") {
      attachment.lastSeen = new Date().toISOString();
      socket.serializeAttachment(attachment);
      return;
    }

    if (payload.type === "result") {
      const pending = this.pending.get(String(payload.requestId || ""));
      if (!pending || pending.deviceId !== attachment.deviceId) return;
      clearTimeout(pending.timer);
      this.pending.delete(payload.requestId);
      pending.resolve(payload);
    }
  }

  async webSocketClose(socket) {
    await this.markOffline(socket);
  }

  async webSocketError(socket) {
    await this.markOffline(socket);
  }

  async markOffline(socket) {
    const attachment = socket.deserializeAttachment();
    if (!attachment?.deviceId) return;
    await this.ctx.storage.put(`device:${attachment.deviceId}`, publicDevice({
      ...attachment,
      id: attachment.deviceId,
      status: "offline",
      lastSeen: new Date().toISOString(),
    }));
    for (const [requestId, pending] of this.pending) {
      if (pending.deviceId !== attachment.deviceId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error(`Device ${attachment.deviceId} disconnected.`));
    }
  }
}

function registry(env) {
  return env.DEVICE_REGISTRY.get(env.DEVICE_REGISTRY.idFromName("global-device-registry"));
}

function authorizedMcpPath(url, env) {
  return env.MCP_PATH_TOKEN && url.pathname === `/mcp/${env.MCP_PATH_TOKEN}`;
}

async function handleToolCall(params, env) {
  const name = String(params?.name || "");
  const args = params?.arguments || {};
  const stub = registry(env);

  if (name === "list_devices") {
    const response = await stub.fetch("https://registry/devices");
    const result = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }

  if (name === "device_call") {
    const response = await stub.fetch("https://registry/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: args.deviceId,
        toolName: args.toolName,
        arguments: args.arguments || {},
        timeoutSeconds: args.timeoutSeconds,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const envelope = await response.json();
    if (!envelope.ok || envelope.error) {
      return { isError: true, content: [{ type: "text", text: envelope.error || "Device call failed." }] };
    }
    const inner = envelope.result || {};
    return {
      ...(inner.isError ? { isError: true } : {}),
      content: Array.isArray(inner.content) ? inner.content : [{ type: "text", text: JSON.stringify(inner) }],
      ...(inner.structuredContent === undefined ? {} : { structuredContent: inner.structuredContent }),
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcp(request, env) {
  if (request.method === "GET") return new Response("This stateless MCP uses HTTP POST.", { status: 405, headers: { allow: "POST" } });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  let message;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  const id = message?.id;
  const method = message?.method;
  if (!method) return rpcError(id, -32600, "Invalid Request");
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  try {
    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ChatGPT Device Control", version: "1.0.0" },
        instructions: "Call list_devices first, then use device_call with a listed online device and one of its advertised capabilities.",
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "tools/call") return rpcResult(id, await handleToolCall(message.params, env));
    return rpcError(id, -32601, "Method not found");
  } catch (error) {
    return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/agent") {
      if (!env.DEVICE_GATEWAY_TOKEN || request.headers.get("authorization") !== `Bearer ${env.DEVICE_GATEWAY_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      return registry(env).fetch("https://registry/connect", request);
    }
    if (authorizedMcpPath(url, env)) return handleMcp(request, env);
    if (url.pathname === "/") return json({ service: "ChatGPT Device Control", status: "ok" });
    return new Response("Not found", { status: 404 });
  },
};
