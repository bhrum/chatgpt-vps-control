import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, hostname, platform, release, totalmem, freemem } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PREFIX = process.env.MCP_PATH_PREFIX ?? "/mcp";
const TOKEN = process.env.VPS_APP_TOKEN ?? "";
const HISTORY_PATH = process.env.HISTORY_PATH ?? resolve(process.cwd(), "history.jsonl");
const MAX_OUTPUT_CHARS = Number(process.env.MAX_OUTPUT_CHARS ?? 12000);
const MAX_TIMEOUT_SECONDS = Number(process.env.MAX_TIMEOUT_SECONDS ?? 600);
const NO_AUTH_SECURITY_SCHEMES = [{ type: "noauth" }];

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

function tokenFromRequest(req, url) {
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
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

function isAuthorized(req, url) {
  return tokenFromRequest(req, url) === TOKEN;
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

function toolMeta(invoking, invoked) {
  return {
    securitySchemes: NO_AUTH_SECURITY_SCHEMES,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

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
      _meta: toolMeta("Running shell command", "Shell command finished"),
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
      _meta: toolMeta("Writing text file", "Text file write finished"),
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

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && isMcpPath(url.pathname)) {
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

  const allowedMethods = new Set(["POST", "GET", "DELETE"]);
  if (isMcpPath(url.pathname) && req.method && allowedMethods.has(req.method)) {
    if (!isAuthorized(req, url)) {
      res.writeHead(401, {
        ...corsHeaders(),
        "WWW-Authenticate": 'Bearer realm="oracle-vps-control"',
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
