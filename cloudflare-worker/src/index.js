import { AuthStore, authStore, verifyBearer } from "./auth.js";
import { SENSITIVE_INPUT_UI } from "./sensitive-input-ui.js";

const MAX_CALL_TIMEOUT_SECONDS = 600;
const DEFAULT_CALL_TIMEOUT_SECONDS = 120;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const SENSITIVE_INPUT_TTL_SECONDS = 5 * 60;
const SENSITIVE_INPUT_RESOURCE_URI = "ui://widget/sensitive-input-v1.html";

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
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String).filter((name) => name !== "secure_input_submit").slice(0, 100) : [],
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
    securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }] },
  },
  {
    name: "device_call",
    title: "Call a tool on a device",
    description: "Call one advertised MCP tool on a selected online computer for non-sensitive operations. Obtain deviceId and toolName from list_devices. Pass arguments as an object. Never include passwords, OTPs, API keys, payment data, personal information, private account choices, consent, or other sensitive values; use render_sensitive_input for those.",
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
    securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }] },
  },
  {
    name: "render_sensitive_input",
    title: "Request private user input",
    description: "Pause device control and render a private user-input card for passwords, OTPs, API keys, payment data, personal information, account choices, consent, or any other sensitive value. Never place sensitive values in device_call arguments. Use exact {{fieldId}} placeholders as complete values in step arguments; the selected device substitutes them only after end-to-end decryption.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", minLength: 1, maxLength: 128 },
        title: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", minLength: 1, maxLength: 600 },
        fields: {
          type: "array", minItems: 1, maxItems: 10,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" },
              label: { type: "string", minLength: 1, maxLength: 120 },
              type: { type: "string", enum: ["password", "otp", "secret", "text", "email", "phone", "payment", "select", "confirm"] },
              placeholder: { type: "string", maxLength: 160 },
              help: { type: "string", maxLength: 240 },
              required: { type: "boolean", default: true },
              options: {
                type: "array", maxItems: 50,
                items: {
                  type: "object",
                  properties: { value: { type: "string", maxLength: 500 }, label: { type: "string", maxLength: 160 } },
                  required: ["value", "label"], additionalProperties: false,
                },
              },
            },
            required: ["id", "label", "type"], additionalProperties: false,
          },
        },
        steps: {
          type: "array", minItems: 1, maxItems: 10,
          items: {
            type: "object",
            properties: {
              toolName: { type: "string", minLength: 1, maxLength: 128 },
              arguments: { type: "object", additionalProperties: true },
            },
            required: ["toolName", "arguments"], additionalProperties: false,
          },
        },
      },
      required: ["deviceId", "title", "description", "fields", "steps"], additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        challengeId: { type: "string" }, deviceId: { type: "string" }, deviceName: { type: "string" },
        title: { type: "string" }, description: { type: "string" }, fields: { type: "array", items: { type: "object" } },
        expiresAt: { type: "number" }, devicePublicKey: { type: "object" }, status: { type: "string", enum: ["awaiting_user"] },
      },
      required: ["challengeId", "deviceId", "deviceName", "title", "description", "fields", "expiresAt", "devicePublicKey", "status"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }],
    _meta: {
      ui: { resourceUri: SENSITIVE_INPUT_RESOURCE_URI },
      "openai/outputTemplate": SENSITIVE_INPUT_RESOURCE_URI,
      "openai/toolInvocation/invoking": "Preparing private input…",
      "openai/toolInvocation/invoked": "Waiting for your private input",
      securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }],
    },
  },
  {
    name: "submit_sensitive_input",
    title: "Submit encrypted private input",
    description: "Widget-only endpoint. Submit an encrypted sensitive-input envelope. The model must never call this tool or supply plaintext values.",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: { type: "string", minLength: 16, maxLength: 64 },
        ephemeralPublicKey: { type: "object", additionalProperties: true },
        iv: { type: "string", minLength: 16, maxLength: 64 },
        ciphertext: { type: "string", minLength: 16, maxLength: 100000 },
      },
      required: ["challengeId", "ephemeralPublicKey", "iv", "ciphertext"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }] },
  },
  {
    name: "cancel_sensitive_input",
    title: "Cancel private input",
    description: "Cancel one pending private-input request without sending any value to the device.",
    inputSchema: {
      type: "object", properties: { challengeId: { type: "string", minLength: 16, maxLength: 64 } }, required: ["challengeId"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["device.control"] }] },
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

    if (url.pathname === "/sensitive/create" && request.method === "POST") {
      return json(await this.createSensitiveChallenge(await request.json()));
    }

    if (url.pathname === "/sensitive/submit" && request.method === "POST") {
      return json(await this.submitSensitiveChallenge(await request.json()));
    }

    if (url.pathname === "/sensitive/cancel" && request.method === "POST") {
      return json(await this.cancelSensitiveChallenge(await request.json()));
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
        secureInputPublicKey: payload.secureInputPublicKey?.kty === "EC" && payload.secureInputPublicKey?.crv === "P-256"
          ? {
              kty: "EC",
              crv: "P-256",
              x: String(payload.secureInputPublicKey.x || "").slice(0, 200),
              y: String(payload.secureInputPublicKey.y || "").slice(0, 200),
              ext: true,
            }
          : null,
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

  async createSensitiveChallenge(body) {
    const deviceId = String(body?.deviceId || "");
    const connection = this.socketForDevice(deviceId);
    if (!connection) throw new Error(`Device ${deviceId} is offline.`);
    if (!connection.attachment.capabilities?.includes("secure_input_submit") || !connection.attachment.secureInputPublicKey?.x) {
      throw new Error(`Device ${deviceId} does not support end-to-end encrypted sensitive input yet.`);
    }
    const challengeId = crypto.randomUUID();
    const expiresAt = Date.now() + SENSITIVE_INPUT_TTL_SECONDS * 1000;
    const record = {
      challengeId,
      deviceId,
      deviceName: connection.attachment.name || deviceId,
      title: String(body?.title || "Sensitive input required").slice(0, 120),
      description: String(body?.description || "Enter the requested information to continue on the selected device.").slice(0, 600),
      fields: body.fields,
      steps: body.steps,
      expiresAt,
    };
    await this.ctx.storage.put(`sensitive:${challengeId}`, record, { expirationTtl: SENSITIVE_INPUT_TTL_SECONDS });
    return { ...record, steps: undefined, devicePublicKey: connection.attachment.secureInputPublicKey };
  }

  async submitSensitiveChallenge(body) {
    const challengeId = String(body?.challengeId || "");
    const key = `sensitive:${challengeId}`;
    const record = await this.ctx.storage.get(key);
    if (!record || record.expiresAt < Date.now()) throw new Error("This sensitive-input request is invalid or expired.");
    await this.ctx.storage.delete(key);
    const envelope = body?.envelope;
    if (!envelope || typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > 100_000) throw new Error("Encrypted input is invalid.");
    const response = await this.callDevice({
      deviceId: record.deviceId,
      toolName: "secure_input_submit",
      arguments: { challengeId, envelope, steps: record.steps },
      timeoutSeconds: DEFAULT_CALL_TIMEOUT_SECONDS,
    });
    if (!response.ok || response.error) throw new Error(response.error || "Sensitive input failed on the device.");
    return {
      challengeId,
      deviceId: record.deviceId,
      deviceName: record.deviceName,
      status: "completed",
      completedSteps: Number(response.result?.structuredContent?.completedSteps || record.steps.length),
    };
  }

  async cancelSensitiveChallenge(body) {
    const challengeId = String(body?.challengeId || "");
    const key = `sensitive:${challengeId}`;
    const record = await this.ctx.storage.get(key);
    if (record) await this.ctx.storage.delete(key);
    return { challengeId, status: "cancelled" };
  }
}

function registry(env) {
  return env.DEVICE_REGISTRY.get(env.DEVICE_REGISTRY.idFromName("global-device-registry"));
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
    if (args.toolName === "secure_input_submit") throw new Error("secure_input_submit is reserved for the encrypted private-input card.");
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

  if (name === "render_sensitive_input") {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!validDeviceId(args.deviceId) || fields.length < 1 || fields.length > 10 || steps.length < 1 || steps.length > 10) {
      throw new Error("Invalid sensitive-input request.");
    }
    const ids = new Set();
    for (const field of fields) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(String(field?.id || "")) || ids.has(field.id)) throw new Error("Sensitive field IDs must be unique identifiers.");
      ids.add(field.id);
      if (!["password", "otp", "secret", "text", "email", "phone", "payment", "select", "confirm"].includes(field.type)) throw new Error(`Unsupported sensitive field type: ${field.type}.`);
      if (field.type === "select" && (!Array.isArray(field.options) || field.options.length < 1)) throw new Error(`Select field ${field.id} requires options.`);
    }
    for (const step of steps) {
      if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(String(step?.toolName || "")) || step.toolName === "secure_input_submit") throw new Error("Invalid sensitive-input target tool.");
      if (!step.arguments || Array.isArray(step.arguments) || typeof step.arguments !== "object") throw new Error("Each sensitive-input step requires an arguments object.");
    }
    const response = await stub.fetch("https://registry/sensitive/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: args.deviceId,
        title: args.title,
        description: args.description,
        fields: fields.map((field) => ({
          id: String(field.id), label: String(field.label || field.id).slice(0, 120), type: field.type,
          placeholder: String(field.placeholder || "").slice(0, 160), help: String(field.help || "").slice(0, 240),
          required: field.required !== false,
          ...(field.type === "select" ? { options: field.options.slice(0, 50).map((option) => ({ value: String(option.value).slice(0, 500), label: String(option.label).slice(0, 160) })) } : {}),
        })),
        steps,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const challenge = await response.json();
    const result = { ...challenge, status: "awaiting_user" };
    return {
      structuredContent: result,
      content: [{ type: "text", text: `Private user input is required on ${result.deviceName}. Waiting for the user to complete the secure card; do not ask them to type the value in chat.` }],
    };
  }

  if (name === "submit_sensitive_input") {
    const response = await stub.fetch("https://registry/sensitive/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: args.challengeId,
        envelope: { ephemeralPublicKey: args.ephemeralPublicKey, iv: args.iv, ciphertext: args.ciphertext },
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    return {
      structuredContent: result,
      content: [{ type: "text", text: `Private input was completed on ${result.deviceName}. No sensitive value was returned. Continue the paused task from the resulting device state.` }],
    };
  }

  if (name === "cancel_sensitive_input") {
    const response = await stub.fetch("https://registry/sensitive/cancel", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: args.challengeId }),
    });
    const result = await response.json();
    return { structuredContent: result, content: [{ type: "text", text: "The private-input request was cancelled. No value was sent." }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function publicOrigin(request, env) {
  return String(env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/u, "");
}

function protectedResourceMetadata(request, env) {
  const origin = publicOrigin(request, env);
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["device.control"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  });
}

function authorizationServerMetadata(request, env) {
  const origin = publicOrigin(request, env);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["device.control"],
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title, body, script = "") {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#18202b}.card{width:min(420px,calc(100vw - 40px));background:white;border:1px solid #dce2ea;border-radius:18px;padding:30px;box-shadow:0 18px 50px #17203318}h1{font-size:24px;margin:0 0 8px}p{line-height:1.55;color:#5a6472}label{display:block;font-size:14px;margin:18px 0 7px}input{box-sizing:border-box;width:100%;font:inherit;padding:12px 14px;border:1px solid #bcc5d1;border-radius:10px;background:white;color:#18202b}button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:10px;background:#1677ff;color:white;font:600 16px inherit;cursor:pointer}.error{color:#b42318}.success{color:#087443}.fine{font-size:12px}@media(prefers-color-scheme:dark){body{background:#111827;color:#eef2f7}.card{background:#1f2937;border-color:#374151}p{color:#bac3cf}input{background:#111827;color:#eef2f7;border-color:#4b5563}}</style></head><body><main class="card">${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" },
  });
}

function setupPage() {
  return page("初始化控制密码", `<h1>设置控制密码</h1><p>此页面只能成功使用一次。密码仅以加盐哈希保存，至少 12 个字符。</p><form id="setup"><label for="password">新密码</label><input id="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><label for="confirm">再次输入</label><input id="confirm" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><button>保存密码</button><p id="message" class="fine"></p></form>`, `
  const form=document.querySelector('#setup'),message=document.querySelector('#message');
  form.addEventListener('submit',async(event)=>{event.preventDefault();message.className='fine';message.textContent='正在保存…';
    const password=document.querySelector('#password').value,confirm=document.querySelector('#confirm').value;
    if(password!==confirm){message.className='fine error';message.textContent='两次密码不一致。';return}
    const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
    let response,result={};try{response=await fetch('/setup',{method:'POST',headers:{'content-type':'application/json','x-setup-token':token},body:JSON.stringify({password})});const raw=await response.text();try{result=JSON.parse(raw)}catch{result={error_description:'服务暂时不可用（HTTP '+response.status+'）。'}}}catch{message.className='fine error';message.textContent='无法连接认证服务，请稍后重试。';return}
    if(response.ok){history.replaceState(null,'','/setup');form.reset();message.className='fine success';message.textContent='设置完成。现在可以回到 ChatGPT 连接 MCP。'}
    else{message.className='fine error';message.textContent=result.error_description||'设置失败。'}
  });`);
}

function authorizePage(params, error = "") {
  const fields = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) || "")}">`).join("");
  return page("授权设备控制", `<h1>授权设备控制</h1><p>输入控制密码，允许 ChatGPT 列出并操作已连接的设备。</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/oauth/authorize">${fields}<label for="password">控制密码</label><input id="password" name="password" type="password" minlength="12" maxlength="256" autocomplete="current-password" autofocus required><button>授权登录</button></form><p class="fine">授权后将自动续期；你可以随时撤销全部登录。</p>`);
}

function managePage(message = "", isError = false) {
  return page("管理设备控制授权", `<h1>管理授权</h1><p>撤销后，所有 ChatGPT 连接都必须重新输入密码。</p>${message ? `<p class="${isError ? "error" : "success"}">${escapeHtml(message)}</p>` : ""}<form method="post" action="/manage/revoke-all"><label for="password">控制密码</label><input id="password" name="password" type="password" minlength="12" maxlength="256" autocomplete="current-password" required><button>撤销全部授权</button></form>`);
}

async function readForm(request) {
  const form = await request.formData();
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
}

async function handleOAuth(request, env) {
  const url = new URL(request.url);
  const origin = publicOrigin(request, env);
  if (url.pathname === "/oauth/register" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_client_metadata", error_description: "Invalid JSON body." }, 400, { "cache-control": "no-store" });
    }
    return authStore(env).fetch("https://auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  if (url.pathname === "/oauth/authorize" && request.method === "GET") return authorizePage(url.searchParams);
  if (url.pathname === "/oauth/authorize" && request.method === "POST") {
    const body = await readForm(request);
    if (body.resource !== `${origin}/mcp`) return authorizePage(new URLSearchParams(body), "请求的 MCP 地址不正确。");
    const response = await authStore(env).fetch("https://auth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": request.headers.get("cf-connecting-ip") || "unknown" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) return authorizePage(new URLSearchParams(body), result.error_description || "授权失败。");
    const redirect = new URL(body.redirect_uri);
    redirect.searchParams.set("code", result.code);
    if (body.state) redirect.searchParams.set("state", body.state);
    return Response.redirect(redirect.toString(), 302);
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    const body = await readForm(request);
    return authStore(env).fetch("https://auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  if (url.pathname === "/oauth/revoke" && request.method === "POST") {
    const body = await readForm(request);
    return authStore(env).fetch("https://auth/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  return new Response("Not found", { status: 404 });
}

function oauthChallenge(request, env) {
  const origin = publicOrigin(request, env);
  return new Response(JSON.stringify({ error: "unauthorized", error_description: "OAuth authorization is required." }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="device.control"`,
    },
  });
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
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: "ChatGPT Device Control", version: "1.1.0" },
        instructions: "Call list_devices first, then use device_call for ordinary non-sensitive operations. Whenever a password, OTP, API key, payment detail, personal value, account choice, consent, or other sensitive input/selection is required, never place it in chat or device_call. Call render_sensitive_input so the user supplies it in the encrypted UI card, wait for completion, then continue from the new device state.",
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "tools/call") return rpcResult(id, await handleToolCall(message.params, env));
    if (method === "resources/list") return rpcResult(id, {
      resources: [{ name: "Private user input", uri: SENSITIVE_INPUT_RESOURCE_URI, mimeType: "text/html;profile=mcp-app", description: "End-to-end encrypted user input and choice card." }],
    });
    if (method === "resources/read") {
      if (message.params?.uri !== SENSITIVE_INPUT_RESOURCE_URI) return rpcError(id, -32002, "Resource not found");
      return rpcResult(id, {
        contents: [{
          uri: SENSITIVE_INPUT_RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: SENSITIVE_INPUT_UI,
          _meta: { ui: { prefersBorder: true } },
        }],
      });
    }
    return rpcError(id, -32601, "Method not found");
  } catch (error) {
    return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (["/.well-known/oauth-protected-resource", "/mcp/.well-known/oauth-protected-resource"].includes(url.pathname)) return protectedResourceMetadata(request, env);
    if (["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(url.pathname)) return authorizationServerMetadata(request, env);
    if (url.pathname.startsWith("/oauth/")) return handleOAuth(request, env);
    if (url.pathname === "/setup" && request.method === "GET") return setupPage();
    if (url.pathname === "/setup" && request.method === "POST") {
      return authStore(env).fetch("https://auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json", "x-setup-token": request.headers.get("x-setup-token") || "" },
        body: await request.text(),
      });
    }
    if (url.pathname === "/manage" && request.method === "GET") return managePage();
    if (url.pathname === "/manage/revoke-all" && request.method === "POST") {
      const body = await readForm(request);
      const response = await authStore(env).fetch("https://auth/revoke-all", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": request.headers.get("cf-connecting-ip") || "unknown" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      return response.ok ? managePage(`已撤销 ${result.revoked} 个令牌。`) : managePage(result.error_description || "撤销失败。", true);
    }
    if (url.pathname === "/agent") {
      if (!env.DEVICE_GATEWAY_TOKEN || request.headers.get("authorization") !== `Bearer ${env.DEVICE_GATEWAY_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      return registry(env).fetch("https://registry/connect", request);
    }
    if (url.pathname === "/mcp") {
      if (!(await verifyBearer(request, env))) return oauthChallenge(request, env);
      return handleMcp(request, env);
    }
    if (env.MCP_PATH_TOKEN && url.pathname === `/mcp/${env.MCP_PATH_TOKEN}`) return handleMcp(request, env);
    if (url.pathname === "/") return json({ service: "ChatGPT Device Control", status: "ok", mcp: `${publicOrigin(request, env)}/mcp`, authentication: "OAuth 2.1 + PKCE" });
    return new Response("Not found", { status: 404 });
  },
};

export { AuthStore };
