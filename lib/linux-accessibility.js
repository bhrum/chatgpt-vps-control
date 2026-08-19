import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const helperPath = join(rootDir, "native", "linux", "accessibility-helper.py");
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function runHelper(payload, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      NO_AT_BRIDGE: "0",
      GTK_MODULES: process.env.GTK_MODULES || "gail:atk-bridge",
    };
    const child = spawn("python3", [helperPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Linux accessibility helper timed out."));
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Linux accessibility helper output was too large."));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      if (settled) return;
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return finish(new Error(errorText || `Linux accessibility helper exited with ${code}.`));
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")); }
      catch { return finish(new Error(`Linux accessibility helper returned invalid JSON. ${errorText}`)); }
      if (!parsed?.ok) return finish(new Error(parsed?.error || "Linux accessibility helper failed."));
      finish(null, parsed);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function linuxAccessibilityDoctor() {
  try {
    return await runHelper({ mode: "doctor" }, 8000);
  } catch (error) {
    return { ok: false, source: "linux-atspi", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listLinuxAccessibilityElements(options = {}) {
  const result = await runHelper({ mode: "list", ...options });
  return {
    ...result,
    screenshot: options.includeScreenshot === true && result.screenshotBase64
      ? { mimeType: result.screenshotMimeType || "image/png", data: result.screenshotBase64, scope: result.screenshotScope || "application", bounds: result.screenshotBounds ?? null }
      : null,
  };
}

export async function listLinuxApplications() {
  const result = await runHelper({ mode: "applications" });
  return (result.applications ?? []).map((application) => ({
    id: String(application.id ?? ""),
    displayName: String(application.displayName ?? application.id ?? ""),
    path: String(application.path ?? ""),
    isRunning: application.isRunning === true,
    pid: Number.isInteger(application.pid) ? application.pid : null,
    lastUsedDate: application.lastUsedDate == null ? null : String(application.lastUsedDate),
    useCount: Number.isInteger(application.useCount) ? application.useCount : null,
  }));
}

export function activateLinuxApplication(application) {
  return runHelper({ mode: "activate", application }, 12_000);
}

export function linuxAccessibilityElementAction({ elementId, action, value = "", ...details }) {
  return runHelper({ mode: "action", elementId, action, value, ...details });
}
