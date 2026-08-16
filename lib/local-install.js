import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { nativeComputerDoctor } from "./native-computer-backend.js";
import { linuxDisplayStatus } from "./linux-desktop.js";
import { linuxAccessibilityDoctor } from "./linux-accessibility.js";

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(here, "..");
export const appHome = resolve(process.env.CHATGPT_COMPUTER_HOME || join(homedir(), ".chatgpt-computer-control"));
export const envPath = join(appHome, ".env");
export const binDir = join(appHome, "bin");
export const nativeDir = join(appHome, "native");

function commandExists(command) {
  const result = spawnSync(platform() === "win32" ? "where.exe" : "sh", platform() === "win32" ? [command] : ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function runInteractive(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: false });
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with ${code}`)));
  });
}

async function ensureLinuxDependencies() {
  const required = ["xdotool", "ffmpeg", "xrandr", "xdpyinfo", "xmodmap", "python3"];
  const missing = required.filter((name) => !commandExists(name));
  const pyatspiMissing = spawnSync("python3", ["-c", "import pyatspi"], { stdio: "ignore" }).status !== 0;
  if (missing.length === 0 && !pyatspiMissing) return { installed: [], missing: [] };
  if (!commandExists("apt-get")) {
    return { installed: [], missing, warning: `Missing ${missing.join(", ")}; automatic installation currently supports apt-based Linux.` };
  }
  const packages = ["xdotool", "ffmpeg", "x11-utils", "x11-xserver-utils", "xvfb", "x11vnc", "xfwm4", "dbus-x11", "at-spi2-core", "python3-pyatspi", "gir1.2-atspi-2.0", "libglib2.0-bin"];
  const elevated = typeof process.getuid === "function" && process.getuid() === 0;
  const prefix = elevated ? [] : ["sudo"];
  const command = elevated ? "apt-get" : "sudo";
  const updateArgs = elevated ? ["update"] : ["apt-get", "update"];
  const installArgs = elevated ? ["install", "-y", ...packages] : ["apt-get", "install", "-y", ...packages];
  await runInteractive(command, updateArgs);
  await runInteractive(command, installArgs);
  return { installed: packages, missing: required.filter((name) => !commandExists(name)), pyatspi: spawnSync("python3", ["-c", "import pyatspi"], { stdio: "ignore" }).status === 0 };
}

async function ensureMacHelper() {
  await mkdir(binDir, { recursive: true });
  const source = join(packageRoot, "native", "macos", "ComputerHelper.swift");
  const target = join(binDir, "chatgpt-computer-helper");
  if (!commandExists("xcrun")) {
    throw new Error("macOS native helper needs Xcode Command Line Tools. Run: xcode-select --install");
  }
  await runInteractive("xcrun", ["swiftc", source, "-o", target, "-framework", "AppKit", "-framework", "ApplicationServices"]);
  await chmod(target, 0o700);
  return target;
}

async function ensureWindowsHelper() {
  await mkdir(nativeDir, { recursive: true });
  const source = join(packageRoot, "native", "windows", "computer-helper.ps1");
  const target = join(nativeDir, "computer-helper.ps1");
  await copyFile(source, target);
  return target;
}

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export async function readLocalConfig() {
  try {
    return parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function applyLocalConfig() {
  const config = await readLocalConfig();
  for (const [key, value] of Object.entries(config)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  process.env.CHATGPT_COMPUTER_HOME = appHome;
  process.env.HISTORY_PATH ??= join(appHome, "history.jsonl");
  process.env.OAUTH_TOKEN_STORE_PATH ??= join(appHome, "oauth-tokens.json");
  if (platform() === "darwin") process.env.CHATGPT_COMPUTER_NATIVE_HELPER ??= join(binDir, "chatgpt-computer-helper");
  if (platform() === "win32") process.env.CHATGPT_COMPUTER_NATIVE_HELPER ??= join(nativeDir, "computer-helper.ps1");
  return config;
}

export async function setupLocalComputer({ installDependencies = true, host = "127.0.0.1", port = 8787 } = {}) {
  await mkdir(appHome, { recursive: true, mode: 0o700 });
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const existing = await readLocalConfig();
  const token = existing.VPS_APP_TOKEN && existing.VPS_APP_TOKEN.length >= 24 ? existing.VPS_APP_TOKEN : randomBytes(32).toString("hex");
  const lines = [
    `HOST=${host}`,
    `PORT=${port}`,
    "MCP_PATH_PREFIX=/mcp",
    `VPS_APP_TOKEN=${token}`,
    `HISTORY_PATH=${join(appHome, "history.jsonl")}`,
    `OAUTH_TOKEN_STORE_PATH=${join(appHome, "oauth-tokens.json")}`,
    "MAX_OUTPUT_CHARS=12000",
    "MAX_TIMEOUT_SECONDS=600",
    "COMPUTER_SCREENSHOT_SETTLE_MS=1200",
    "NO_AT_BRIDGE=0",
    "GTK_MODULES=gail:atk-bridge",
  ];
  if (platform() === "darwin") lines.push(`CHATGPT_COMPUTER_NATIVE_HELPER=${join(binDir, "chatgpt-computer-helper")}`);
  if (platform() === "win32") lines.push(`CHATGPT_COMPUTER_NATIVE_HELPER=${join(nativeDir, "computer-helper.ps1")}`);

  let platformSetup = {};
  if (platform() === "linux") {
    platformSetup = installDependencies ? await ensureLinuxDependencies() : {};
    const requestedDisplay = process.env.DISPLAY || existing.DISPLAY || "";
    const displayStatus = linuxDisplayStatus(requestedDisplay);
    if (displayStatus.reachable) {
      lines.push(`DISPLAY=${requestedDisplay}`);
      platformSetup.desktopMode = "native-x11";
      platformSetup.display = requestedDisplay;
    } else {
      const managedDisplay = existing.COMPUTER_MANAGED_X11 === "1" && existing.DISPLAY ? existing.DISPLAY : ":99";
      lines.push(`DISPLAY=${managedDisplay}`);
      lines.push("COMPUTER_MANAGED_X11=1");
      lines.push("COMPUTER_X11_SCREEN=1280x800x24");
      platformSetup.desktopMode = "managed-x11";
      platformSetup.display = managedDisplay;
    }
  } else if (platform() === "darwin") platformSetup = { helper: await ensureMacHelper(), desktopMode: "native-macos" };
  else if (platform() === "win32") platformSetup = { helper: await ensureWindowsHelper(), desktopMode: "native-windows" };
  else throw new Error(`Unsupported platform: ${platform()}`);

  await writeFile(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600).catch(() => {});

  return {
    home: appHome,
    envPath,
    token,
    host,
    port,
    platform: platform(),
    platformSetup,
    mcpUrl: `http://${host}:${port}/mcp/${token}`,
  };
}

async function pathExists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function canExecute(path) {
  try { await access(path, fsConstants.X_OK); return true; } catch { return false; }
}

export async function doctorLocalComputer() {
  await applyLocalConfig();
  const result = {
    platform: platform(),
    home: appHome,
    configExists: await pathExists(envPath),
    checks: [],
    ok: true,
  };
  const push = (name, ok, detail = "") => { result.checks.push({ name, ok, detail }); if (!ok) result.ok = false; };
  const cfg = await readLocalConfig();
  push("authentication token", Boolean(cfg.VPS_APP_TOKEN && cfg.VPS_APP_TOKEN.length >= 24), cfg.VPS_APP_TOKEN ? "configured" : "missing");
  push("node", Number(process.versions.node.split(".")[0]) >= 20, process.version);

  if (platform() === "linux") {
    for (const binary of ["xdotool", "ffmpeg", "xrandr", "xdpyinfo", "xmodmap", "python3"]) push(binary, commandExists(binary));
    const pyatspi = spawnSync("python3", ["-c", "import pyatspi"], { stdio: "ignore" }).status === 0;
    push("AT-SPI Python bridge", pyatspi, pyatspi ? "python3-pyatspi available" : "install python3-pyatspi and at-spi2-core");
    const display = process.env.DISPLAY || cfg.DISPLAY || "";
    push("DISPLAY", Boolean(display), display || "not set");
    if (display && commandExists("xdpyinfo")) {
      const probe = spawnSync("xdpyinfo", ["-display", display], { stdio: "ignore" });
      const reachable = probe.status === 0;
      if (cfg.COMPUTER_MANAGED_X11 === "1" && !reachable) {
        result.checks.push({ name: "managed X11", ok: true, detail: `${display} will be started by the background service` });
      } else {
        push("X11 reachable", reachable, display);
      }
    }
    if (pyatspi && display) {
      const accessibility = await linuxAccessibilityDoctor();
      push("AT-SPI semantic provider", accessibility.ok, accessibility.ok ? `${accessibility.applications ?? 0} accessible applications currently registered` : accessibility.error);
    }
  } else if (platform() === "darwin") {
    const helper = cfg.CHATGPT_COMPUTER_NATIVE_HELPER || join(binDir, "chatgpt-computer-helper");
    push("native helper", await canExecute(helper), helper);
    push("xcrun", commandExists("xcrun"), "needed only to rebuild helper");
    if (await canExecute(helper)) {
      const native = await nativeComputerDoctor({ prompt: true });
      push("Accessibility permission", native.ok && native.permissions?.accessibility === true, native.permissions?.accessibility ? "granted" : "grant in Privacy & Security > Accessibility");
      push("Screen Recording permission", native.ok && native.permissions?.screenRecording === true, native.permissions?.screenRecording ? "granted" : "grant in Privacy & Security > Screen Recording");
    }
  } else if (platform() === "win32") {
    const helper = cfg.CHATGPT_COMPUTER_NATIVE_HELPER || join(nativeDir, "computer-helper.ps1");
    push("native helper", await pathExists(helper), helper);
    push("PowerShell", commandExists("powershell.exe"));
    if (await pathExists(helper) && commandExists("powershell.exe")) {
      const native = await nativeComputerDoctor({ prompt: true });
      push("interactive desktop", native.ok && native.permissions?.interactiveDesktop !== false, native.ok ? "available" : native.error || "unavailable");
    }
  } else {
    push("supported platform", false, platform());
  }
  return result;
}
