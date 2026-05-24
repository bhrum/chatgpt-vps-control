import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname, platform, release, totalmem, freemem } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PREFIX = process.env.MCP_PATH_PREFIX ?? "/mcp";
const TOKEN = process.env.VPS_APP_TOKEN ?? "";
const HISTORY_PATH = process.env.HISTORY_PATH ?? resolve(process.cwd(), "history.jsonl");
const MAX_OUTPUT_CHARS = Number(process.env.MAX_OUTPUT_CHARS ?? 12000);
const MAX_TIMEOUT_SECONDS = Number(process.env.MAX_TIMEOUT_SECONDS ?? 600);
const NO_AUTH_SECURITY_SCHEMES = [{ type: "noauth" }];
const WRITE_SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["vps.write"] }];
const OAUTH_SCOPES = ["vps.read", "vps.write"];
const OAUTH_CODES = new Map();
const OAUTH_TOKENS = new Map();
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_TOKEN_TTL_SECONDS = 24 * 60 * 60;

if (!TOKEN || TOKEN.length < 24) {
  console.error("VPS_APP_TOKEN must be set to a random token of at least 24 characters.");
  process.exit(1);
}

const commandResultSchema = {
  command: z.string(),
  cwd: z.string(),
  status: z.enum(["completed", "failed"]),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
};

const statusSchema = {
  hostname: z.string(),
  platform: z.string(),
  release: z.string(),
  uptime: z.string(),
  memory: z.object({
    totalBytes: z.number(),
    freeBytes: z.number(),
  }),
  disk: z.string(),
  processes: z.string(),
};

const writeTextFileResultSchema = {
  filePath: z.string(),
  mode: z.enum(["create", "append"]),
  bytesWritten: z.number(),
  status: z.enum(["written", "failed"]),
  message: z.string(),
};

const commandResultJsonSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    cwd: { type: "string" },
    status: { type: "string", enum: ["completed", "failed"] },
    exitCode: { type: ["number", "null"] },
    signal: { type: ["string", "null"] },
    durationMs: { type: "number" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["command", "cwd", "status", "exitCode", "signal", "durationMs", "stdout", "stderr", "truncated"],
  additionalProperties: false,
};

const writeTextFileResultJsonSchema = {
  type: "object",
  properties: {
    filePath: { type: "string" },
    mode: { type: "string", enum: ["create", "append"] },
    bytesWritten: { type: "number" },
    status: { type: "string", enum: ["written", "failed"] },
    message: { type: "string" },
  },
  required: ["filePath", "mode", "bytesWritten", "status", "message"],
  additionalProperties: false,
};

function bearerTokenFromRequest(req) {
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  return "";
}

function tokenFromRequest(req, url) {
  const bearerToken = bearerTokenFromRequest(req);
  if (bearerToken) {
    return bearerToken;
  }

  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    return queryToken;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[0] === MCP_PREFIX.replace(/^\//, "") && pathParts[1]) {
    return pathParts[1];
  }

  return "";
}

function isMcpPath(pathname) {
  return pathname === MCP_PREFIX || pathname.startsWith(`${MCP_PREFIX}/`);
}

function hasValidOAuthToken(token, requiredScope = "vps.write") {
  const entry = OAUTH_TOKENS.get(token);
  if (!entry) {
    return false;
  }

  if (entry.expiresAt <= Date.now()) {
    OAUTH_TOKENS.delete(token);
    return false;
  }

  return entry.scopes.includes(requiredScope);
}

function isAuthorized(req, url) {
  return tokenFromRequest(req, url) === TOKEN || hasValidOAuthToken(bearerTokenFromRequest(req));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(payload, null, 2));
}

function publicOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const proto = forwardedProto || (req.headers.host?.startsWith("127.0.0.1") ? "http" : "https");
  const host = forwardedHost || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function oauthMetadata(req) {
  const origin = publicOrigin(req);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: OAUTH_SCOPES,
  };
}

function protectedResourceMetadata(req) {
  const origin = publicOrigin(req);
  return {
    resource: `${origin}${MCP_PREFIX}`,
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES,
    resource_documentation: "https://github.com/bhrum/chatgpt-vps-control",
  };
}

async function readRequestText(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escapes[char];
  });
}

function clipOutput(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }

  const omitted = text.length - MAX_OUTPUT_CHARS;
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${omitted} chars]`,
    truncated: true,
  };
}

function safeCwd(cwd) {
  const fallback = homedir();
  if (!cwd) {
    return fallback;
  }

  const candidate = resolve(cwd.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(candidate)) {
    return fallback;
  }

  const stat = statSync(candidate);
  return stat.isDirectory() ? candidate : fallback;
}

function resolveFilePath(filePath, cwd) {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("filePath must be a non-empty path without null bytes.");
  }

  const expanded = filePath.replace(/^~(?=$|\/)/, homedir());
  return resolve(safeCwd(cwd), expanded);
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function toolMeta(invoking, invoked, securitySchemes = NO_AUTH_SECURITY_SCHEMES) {
  return {
    securitySchemes,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

const TOOL_DESCRIPTORS = [
  {
    name: "vps_status",
    title: "VPS status",
    description: "Read-only status summary for this Oracle Ubuntu VPS.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        hostname: { type: "string" },
        platform: { type: "string" },
        release: { type: "string" },
        uptime: { type: "string" },
        memory: {
          type: "object",
          properties: {
            totalBytes: { type: "number" },
            freeBytes: { type: "number" },
          },
          required: ["totalBytes", "freeBytes"],
          additionalProperties: false,
        },
        disk: { type: "string" },
        processes: { type: "string" },
      },
      required: ["hostname", "platform", "release", "uptime", "memory", "disk", "processes"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: true,
    },
    securitySchemes: NO_AUTH_SECURITY_SCHEMES,
    _meta: toolMeta("Checking VPS status", "VPS status ready"),
  },
  {
    name: "run_shell_command",
    title: "Run shell command",
    description:
      "Run any Bash command on the Oracle VPS as the service user. For root-level operations, prefix commands with sudo.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 2000 },
        cwd: { type: "string", description: "Working directory. Defaults to the service user's home directory." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS },
      },
      required: ["command"],
      additionalProperties: false,
    },
    outputSchema: commandResultJsonSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    securitySchemes: WRITE_SECURITY_SCHEMES,
    _meta: toolMeta("Running shell command", "Shell command finished", WRITE_SECURITY_SCHEMES),
  },
  {
    name: "write_text_file",
    title: "Write text file",
    description:
      "Create a new UTF-8 text file or append text to an existing file on the Oracle VPS. Create mode fails if the file already exists.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: "Absolute path, ~/path, or path relative to cwd.",
        },
        content: { type: "string", maxLength: 200000 },
        mode: { type: "string", enum: ["create", "append"], default: "create" },
        cwd: { type: "string", description: "Base directory for relative filePath values." },
      },
      required: ["filePath", "content"],
      additionalProperties: false,
    },
    outputSchema: writeTextFileResultJsonSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    securitySchemes: WRITE_SECURITY_SCHEMES,
    _meta: toolMeta("Writing text file", "Text file write finished", WRITE_SECURITY_SCHEMES),
  },
  {
    name: "recent_commands",
    title: "Recent commands",
    description: "Show recent command audit entries from this connector.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            ...commandResultJsonSchema,
            properties: {
              ...commandResultJsonSchema.properties,
              at: { type: "string" },
            },
            required: [...commandResultJsonSchema.required, "at"],
          },
        },
      },
      required: ["commands"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    securitySchemes: NO_AUTH_SECURITY_SCHEMES,
    _meta: toolMeta("Reading command history", "Command history ready"),
  },
];

function commandEnv() {
  return {
    HOME: homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    SHELL: "/bin/bash",
    USER: process.env.USER ?? "ubuntu",
  };
}

async function writeHistory(entry) {
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() });
  await appendFile(HISTORY_PATH, `${line}\n`, "utf8");
}

async function readHistory(limit) {
  try {
    const text = await readFile(HISTORY_PATH, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function runCommand(command, cwd, timeoutSeconds, options = {}) {
  const { audit = true } = options;
  const workingDirectory = safeCwd(cwd);
  const timeoutMs = Math.min(Math.max(Number(timeoutSeconds ?? 10), 1), MAX_TIMEOUT_SECONDS) * 1000;
  const started = Date.now();

  try {
    const result = await execFileAsync("/bin/bash", ["-lc", command], {
      cwd: workingDirectory,
      env: commandEnv(),
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const stdout = clipOutput(result.stdout);
    const stderr = clipOutput(result.stderr);
    const completed = {
      command,
      cwd: workingDirectory,
      status: "completed",
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - started,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    };
    if (audit) {
      await writeHistory(completed);
    }
    return completed;
  } catch (error) {
    const stdout = clipOutput(error.stdout);
    const stderr = clipOutput(error.stderr || error.message);
    const failed = {
      command,
      cwd: workingDirectory,
      status: "failed",
      exitCode: Number.isInteger(error.code) ? error.code : null,
      signal: typeof error.signal === "string" ? error.signal : null,
      durationMs: Date.now() - started,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    };
    if (audit) {
      await writeHistory(failed);
    }
    return failed;
  }
}

async function createVpsServer() {
  const server = new McpServer({
    name: "oracle-vps-control",
    version: "0.1.0",
  });

  server.registerTool(
    "vps_status",
    {
      title: "VPS status",
      description: "Read-only status summary for this Oracle Ubuntu VPS.",
      inputSchema: {},
      outputSchema: statusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
      _meta: toolMeta("Checking VPS status", "VPS status ready"),
    },
    async () => {
      const [uptime, disk, processes] = await Promise.all([
        runCommand("uptime", homedir(), 5, { audit: false }),
        runCommand("df -h / /home 2>/dev/null || df -h /", homedir(), 5, { audit: false }),
        runCommand("ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -12", homedir(), 5, { audit: false }),
      ]);
      const structuredContent = {
        hostname: hostname(),
        platform: platform(),
        release: release(),
        uptime: uptime.stdout.trim() || uptime.stderr.trim(),
        memory: {
          totalBytes: totalmem(),
          freeBytes: freemem(),
        },
        disk: disk.stdout.trim() || disk.stderr.trim(),
        processes: processes.stdout.trim() || processes.stderr.trim(),
      };

      return {
        structuredContent,
        content: [
          {
            type: "text",
            text: `VPS ${structuredContent.hostname} is reachable. Uptime: ${structuredContent.uptime}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "run_shell_command",
    {
      title: "Run shell command",
      description:
        "Run any Bash command on the Oracle VPS as the service user. For root-level operations, prefix commands with sudo.",
      inputSchema: {
        command: z.string().min(1).max(2000),
        cwd: z.string().optional().describe("Working directory. Defaults to the service user's home directory."),
        timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      _meta: toolMeta("Running shell command", "Shell command finished", WRITE_SECURITY_SCHEMES),
    },
    async ({ command, cwd, timeoutSeconds }) => {
      const result = await runCommand(command, cwd, timeoutSeconds);
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text:
              result.status === "completed"
                ? `Command completed in ${result.durationMs} ms.`
                : `Command ${result.status}: ${result.stderr}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "write_text_file",
    {
      title: "Write text file",
      description:
        "Create a new UTF-8 text file or append text to an existing file on the Oracle VPS. Create mode fails if the file already exists.",
      inputSchema: {
        filePath: z.string().min(1).max(1000).describe("Absolute path, ~/path, or path relative to cwd."),
        content: z.string().max(200000),
        mode: z.enum(["create", "append"]).default("create"),
        cwd: z.string().optional().describe("Base directory for relative filePath values."),
      },
      outputSchema: writeTextFileResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: toolMeta("Writing text file", "Text file write finished", WRITE_SECURITY_SCHEMES),
    },
    async ({ filePath, content, mode, cwd }) => {
      const writeMode = mode ?? "create";
      let targetPath = "";
      try {
        targetPath = resolveFilePath(filePath, cwd);
        await mkdir(dirname(targetPath), { recursive: true });
        if (writeMode === "append") {
          await appendFile(targetPath, content, "utf8");
        } else {
          await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
        }

        const structuredContent = {
          filePath: targetPath,
          mode: writeMode,
          bytesWritten: byteLength(content),
          status: "written",
          message:
            writeMode === "append"
              ? `Appended ${byteLength(content)} bytes to ${targetPath}.`
              : `Created ${targetPath} with ${byteLength(content)} bytes.`,
        };

        await writeHistory({
          command: `write_text_file ${writeMode} ${targetPath}`,
          cwd: dirname(targetPath),
          status: "completed",
          exitCode: 0,
          signal: null,
          durationMs: 0,
          stdout: structuredContent.message,
          stderr: "",
          truncated: false,
        });

        return {
          structuredContent,
          content: [{ type: "text", text: structuredContent.message }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const structuredContent = {
          filePath: targetPath,
          mode: writeMode,
          bytesWritten: 0,
          status: "failed",
          message,
        };

        await writeHistory({
          command: `write_text_file ${writeMode} ${targetPath || filePath}`,
          cwd: targetPath ? dirname(targetPath) : safeCwd(cwd),
          status: "failed",
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: "",
          stderr: message,
          truncated: false,
        });

        return {
          structuredContent,
          content: [{ type: "text", text: `File write failed: ${message}` }],
        };
      }
    }
  );

  server.registerTool(
    "recent_commands",
    {
      title: "Recent commands",
      description: "Show recent command audit entries from this connector.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional(),
      },
      outputSchema: {
        commands: z.array(z.object(commandResultSchema).extend({ at: z.string() })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Reading command history", "Command history ready"),
    },
    async ({ limit }) => {
      const commands = await readHistory(limit ?? 10);
      return {
        structuredContent: { commands },
        content: [{ type: "text", text: `Returned ${commands.length} recent command entries.` }],
      };
    }
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  return server;
}

async function handleOAuthRegister(req, res) {
  let body = {};
  try {
    const text = await readRequestText(req);
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  writeJson(res, 201, {
    client_id: body.client_id || `chatgpt-${randomToken(12)}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris || [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

function handleOAuthAuthorize(req, res, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  const required = ["client_id", "redirect_uri", "response_type", "state"];
  const missing = required.filter((name) => !params[name]);
  if (missing.length || params.response_type !== "code") {
    writeJson(res, 400, { error: "invalid_request", error_description: `Missing or invalid: ${missing.join(", ")}` });
    return;
  }

  if (url.searchParams.get("approve") !== "1") {
    const hidden = Object.entries(params)
      .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
      .join("\n");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Oracle VPS Control</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; line-height: 1.5;">
    <h1>Authorize Oracle VPS Control</h1>
    <p>This grants ChatGPT permission to use the VPS write tools exposed by this connector.</p>
    <form method="get" action="/oauth/authorize">
      ${hidden}
      <input type="hidden" name="approve" value="1">
      <button style="font: inherit; padding: 10px 16px;">Authorize</button>
    </form>
  </body>
</html>`);
    return;
  }

  const code = randomToken(24);
  const scope = params.scope || OAUTH_SCOPES.join(" ");
  OAUTH_CODES.set(code, {
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
    scopes: scope.split(/\s+/).filter(Boolean),
    expiresAt: Date.now() + OAUTH_CODE_TTL_MS,
  });

  const redirectUrl = new URL(params.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", params.state);
  res.writeHead(302, { location: redirectUrl.href });
  res.end();
}

async function handleOAuthToken(req, res) {
  const text = await readRequestText(req);
  const params = new URLSearchParams(text);
  const grantType = params.get("grant_type");

  if (grantType !== "authorization_code") {
    writeJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  const code = params.get("code") || "";
  const entry = OAUTH_CODES.get(code);
  if (!entry || entry.expiresAt <= Date.now()) {
    OAUTH_CODES.delete(code);
    writeJson(res, 400, { error: "invalid_grant" });
    return;
  }

  const verifier = params.get("code_verifier") || "";
  if (entry.codeChallengeMethod === "S256" && entry.codeChallenge && pkceChallenge(verifier) !== entry.codeChallenge) {
    writeJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
    return;
  }

  OAUTH_CODES.delete(code);
  const accessToken = randomToken(32);
  OAUTH_TOKENS.set(accessToken, {
    scopes: Array.from(new Set([...entry.scopes, ...OAUTH_SCOPES])),
    expiresAt: Date.now() + OAUTH_TOKEN_TTL_SECONDS * 1000,
  });

  writeJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_TOKEN_TTL_SECONDS,
    scope: OAUTH_SCOPES.join(" "),
  });
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && (isMcpPath(url.pathname) || url.pathname.startsWith("/oauth/"))) {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Oracle VPS ChatGPT MCP server. Use /mcp/<token> as the connector URL.");
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, {
      ok: true,
      name: "oracle-vps-control",
      hostname: hostname(),
      mcpPath: `${MCP_PREFIX}/<token>`,
    });
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === `/.well-known/oauth-protected-resource${MCP_PREFIX}`)
  ) {
    writeJson(res, 200, protectedResourceMetadata(req));
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    writeJson(res, 200, oauthMetadata(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    await handleOAuthRegister(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    handleOAuthAuthorize(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    await handleOAuthToken(req, res);
    return;
  }

  const allowedMethods = new Set(["POST", "GET", "DELETE"]);
  if (isMcpPath(url.pathname) && req.method && allowedMethods.has(req.method)) {
    if (!isAuthorized(req, url)) {
      res.writeHead(401, {
        ...corsHeaders(),
        "WWW-Authenticate": `Bearer resource_metadata="${publicOrigin(req)}/.well-known/oauth-protected-resource", scope="vps.write"`,
      });
      res.end("Unauthorized");
      return;
    }

    const server = await createVpsServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`Oracle VPS MCP server listening on http://127.0.0.1:${PORT}${MCP_PREFIX}/<token>`);
});
