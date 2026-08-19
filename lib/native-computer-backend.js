import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { nativeServiceRequest } from "./native-request-service.js";

const API_WIDTH = 1280;
const MAX_HELPER_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_HELPER_TIMEOUT_MS = 60_000;

function helperPath() {
  if (process.env.CHATGPT_COMPUTER_NATIVE_HELPER) {
    return resolve(process.env.CHATGPT_COMPUTER_NATIVE_HELPER);
  }
  const base = process.env.CHATGPT_COMPUTER_HOME ?? join(homedir(), ".chatgpt-computer-control");
  if (platform() === "darwin") {
    const appDir = process.env.CHATGPT_COMPUTER_MAC_APP_DIR
      || (process.env.CHATGPT_COMPUTER_HOME
        ? join(base, "Applications", "ChatGPT Computer Control.app")
        : join(homedir(), "Applications", "ChatGPT Computer Control.app"));
    return join(appDir, "Contents", "MacOS", "ChatGPTComputerControl");
  }
  if (platform() === "win32") return join(base, "native", "computer-helper.ps1");
  return "";
}

export function nativeComputerHelperPath() {
  return helperPath();
}

function run(command, args, { input = "", timeoutMs = MAX_HELPER_TIMEOUT_MS } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill();
        rejectRun(new Error(`Native computer helper output exceeded ${MAX_HELPER_OUTPUT_BYTES} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 512 * 1024) stderr.push(chunk);
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return rejectRun(new Error("Native computer helper timed out."));
      const errText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return rejectRun(new Error(errText || `Native computer helper exited with ${code}.`));
      resolveRun(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

async function invokeHelperOneShot(payload) {
  const os = platform();
  const request = JSON.stringify({ apiWidth: API_WIDTH, ...payload });
  let output;
  if (os === "darwin") {
    const executable = helperPath();
    const marker = ".app/Contents/MacOS/";
    const markerIndex = executable.indexOf(marker);
    if (markerIndex < 0) {
      output = await run(executable, [], { input: request });
    } else {
      const appPath = executable.slice(0, markerIndex + 4);
      const exchangeDir = await mkdtemp(join(tmpdir(), "chatgpt-computer-control-"));
      const requestPath = join(exchangeDir, "request.json");
      const responsePath = join(exchangeDir, "response.json");
      try {
        await writeFile(requestPath, request, { encoding: "utf8", mode: 0o600 });
        await run("/usr/bin/open", ["-n", "-W", appPath, "--args", "--request-file", requestPath, "--response-file", responsePath], {
          timeoutMs: MAX_HELPER_TIMEOUT_MS,
        });
        output = await readFile(responsePath, "utf8");
      } finally {
        await rm(exchangeDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } else if (os === "win32") {
    const powershell = "powershell.exe";
    output = await run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath()], {
      input: request,
    });
  } else {
    throw new Error(`Native computer backend is not used on ${os}.`);
  }
  const parsed = JSON.parse(output);
  if (!parsed || parsed.ok !== true) throw new Error(parsed?.error || "Native computer helper failed.");
  return parsed;
}

async function invokeHelper(payload) {
  if (process.env.CHATGPT_COMPUTER_NATIVE_PERSISTENT !== "0") {
    const os = platform();
    const spec = os === "darwin"
      ? { command: helperPath(), args: ["--request-server"], env: process.env }
      : os === "win32"
        ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath(), "--request-server"], env: process.env }
        : null;
    if (spec) {
      let result;
      try {
        result = await nativeServiceRequest(spec, { apiWidth: API_WIDTH, ...payload });
      } catch {
        // A dead/unavailable broker is a transport failure. Preserve the
        // established one-shot path and let the next call restart the broker.
      }
      if (result) {
        if (result.ok !== true) throw new Error(result.error || "Native computer helper failed.");
        return result;
      }
    }
  }
  return invokeHelperOneShot(payload);
}

function publicState(result, includeScreenshot) {
  const screenshot = includeScreenshot && result.screenshotBase64
    ? {
        mimeType: result.screenshotMimeType || "image/png",
        data: result.screenshotBase64,
        scope: result.screenshotScope || "desktop",
        bounds: result.screenshotBounds ?? null,
      }
    : null;
  return {
    resolution: {
      display: result.displayResolution,
      api: result.apiResolution,
    },
    cursor: result.cursorPosition ?? null,
    active: result.activeWindow ?? null,
    windows: result.windows ?? [],
    screenshot,
  };
}

export function nativeComputerBackendSupported() {
  return platform() === "darwin" || platform() === "win32";
}

export function nativeComputerBackendName() {
  if (platform() === "darwin") return "macos-coregraphics-accessibility";
  if (platform() === "win32") return "windows-user32-gdi";
  return "linux-x11";
}

export async function nativeComputerState({ includeScreenshot = true, includeWindows = true } = {}) {
  const result = await invokeHelper({ actions: [], includeScreenshot, includeWindows });
  return publicState(result, includeScreenshot);
}

export async function nativeComputerUse(actions, { application, activateApplication = false } = {}) {
  const result = await invokeHelper({
    actions,
    includeScreenshot: true,
    includeWindows: false,
    targetApplication: application || undefined,
    activateTargetApplication: activateApplication === true,
  });
  return publicState(result, true);
}

export async function nativeComputerWindowAction({ windowId, expectedName, action, x, y, width, height }) {
  const actionResponse = await invokeHelper({
    actions: [],
    includeScreenshot: false,
    includeWindows: true,
    windowAction: { windowId, expectedName, action, x, y, width, height },
  });
  let stateResponse = actionResponse;
  try {
    stateResponse = await invokeHelper({ actions: [], includeScreenshot: true, includeWindows: true });
  } catch {
    // The window mutation already succeeded. A denied/failed post-action
    // capture must not turn it into an apparent failure that callers retry.
  }
  return {
    ...publicState(stateResponse, true),
    actionResult: actionResponse.windowActionResult ?? { ok: true, source: nativeComputerBackendName(), action, windowId },
  };
}

export async function nativeComputerApplications() {
  const result = await invokeHelper({
    actions: [],
    includeScreenshot: false,
    includeWindows: false,
    listApplications: true,
  });
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


export async function nativeComputerElements(options = {}) {
  const includeScreenshot = options.includeScreenshot === true;
  const result = await invokeHelper({
    actions: [],
    includeScreenshot,
    includeWindows: false,
    targetApplication: options.launchIfNeeded ? (options.application || undefined) : undefined,
    activateTargetApplication: options.activateApplication === true,
    includeElements: true,
    elementOptions: options,
  });
  return {
    source: result.elementSource || result.source || nativeComputerBackendName(),
    application: result.elementApplication ?? result.application ?? null,
    applicationId: result.elementApplicationId ?? result.applicationId ?? null,
    elements: result.elements ?? [],
    screenshot: includeScreenshot && result.screenshotBase64
      ? { mimeType: result.screenshotMimeType || "image/png", data: result.screenshotBase64, scope: result.screenshotScope || "desktop", bounds: result.screenshotBounds ?? null }
      : null,
    message: result.elementMessage || result.message || `Returned ${(result.elements ?? []).length} accessibility elements.`,
  };
}

export async function nativeComputerElementAction({ elementId, action, value = "", ...details }) {
  const result = await invokeHelper({
    actions: [],
    includeScreenshot: false,
    includeWindows: false,
    elementAction: { elementId, action, value, ...details },
  });
  return result.elementActionResult ?? { ok: true, source: nativeComputerBackendName(), action };
}

export async function nativeComputerDoctor({ prompt = false } = {}) {
  if (!nativeComputerBackendSupported()) return { ok: false, backend: "linux-x11", error: "Native helper is only for macOS and Windows." };
  try {
    const result = await invokeHelper({ actions: [], includeScreenshot: false, includeWindows: false, doctor: prompt });
    return {
      ok: true,
      backend: nativeComputerBackendName(),
      permissions: result.permissions ?? {},
      displayResolution: result.displayResolution,
      helper: helperPath(),
    };
  } catch (error) {
    return {
      ok: false,
      backend: nativeComputerBackendName(),
      helper: helperPath(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
