import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { arch, homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { nativeComputerDoctor } from "./native-computer-backend.js";
import { linuxDisplayStatus } from "./linux-desktop.js";
import { linuxAccessibilityDoctor } from "./linux-accessibility.js";
import { installPrivateRuntime } from "./runtime-install.js";

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(here, "..");
export const appHome = resolve(process.env.CHATGPT_COMPUTER_HOME || join(homedir(), ".chatgpt-computer-control"));
export const envPath = join(appHome, ".env");
export const binDir = join(appHome, "bin");
export const nativeDir = join(appHome, "native");
// A real per-user Applications location lets Launch Services resolve the bundle
// for TCC, so permission prompts show the product name instead of the launcher.
// Tests and isolated installs that set CHATGPT_COMPUTER_HOME keep their bundle
// under that sandbox unless an explicit app directory is supplied.
export const macAppDir = resolve(
  process.env.CHATGPT_COMPUTER_MAC_APP_DIR
    || (process.env.CHATGPT_COMPUTER_HOME
      ? join(appHome, "Applications", "ChatGPT Computer Control.app")
      : join(homedir(), "Applications", "ChatGPT Computer Control.app")),
);
export const macHelperExecutable = join(macAppDir, "Contents", "MacOS", "ChatGPTComputerControl");
export const macRequestServiceDir = join(macAppDir, "Contents", "XPCServices", "com.bhrum.computer-control.request-service.xpc");
export const macRequestServiceExecutable = join(macRequestServiceDir, "Contents", "MacOS", "ChatGPTComputerRequestService");
const macBundleIdentifier = "com.bhrum.computer-control";

export async function installLocalRuntime() {
  return installPrivateRuntime({ sourceRoot: packageRoot, appHome });
}

export async function syncMacGatewayTokenFallback() {
  if (platform() !== "darwin") return { updated: false, reason: "not-macos" };
  const config = await readLocalConfig();
  const service = String(config.DEVICE_GATEWAY_TOKEN_KEYCHAIN_SERVICE || "");
  const account = String(config.DEVICE_GATEWAY_TOKEN_KEYCHAIN_ACCOUNT || "device-gateway-token");
  if (!service) return { updated: false, reason: "keychain-not-configured" };
  const token = execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (token.length < 32) throw new Error("The macOS Keychain device gateway token is invalid.");
  const current = await readFile(envPath, "utf8");
  const replacement = `DEVICE_GATEWAY_TOKEN=${token}`;
  const next = /^DEVICE_GATEWAY_TOKEN=.*$/mu.test(current)
    ? current.replace(/^DEVICE_GATEWAY_TOKEN=.*$/mu, replacement)
    : `${current.replace(/\n?$/u, "\n")}${replacement}\n`;
  await writeFile(envPath, next, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600);
  return { updated: true };
}

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
  const required = ["xdotool", "wmctrl", "ffmpeg", "xrandr", "xdpyinfo", "xmodmap", "python3"];
  const missing = required.filter((name) => !commandExists(name));
  const pyatspiMissing = spawnSync("python3", ["-c", "import pyatspi"], { stdio: "ignore" }).status !== 0;
  if (missing.length === 0 && !pyatspiMissing) return { installed: [], missing: [] };
  if (!commandExists("apt-get")) {
    return { installed: [], missing, warning: `Missing ${missing.join(", ")}; automatic installation currently supports apt-based Linux.` };
  }
  const packages = ["xdotool", "wmctrl", "ffmpeg", "x11-utils", "x11-xserver-utils", "xvfb", "x11vnc", "xfwm4", "dbus-x11", "at-spi2-core", "python3-pyatspi", "gir1.2-atspi-2.0", "libglib2.0-bin"];
  const elevated = typeof process.getuid === "function" && process.getuid() === 0;
  const prefix = elevated ? [] : ["sudo"];
  const command = elevated ? "apt-get" : "sudo";
  const updateArgs = elevated ? ["update"] : ["apt-get", "update"];
  const installArgs = elevated ? ["install", "-y", ...packages] : ["apt-get", "install", "-y", ...packages];
  await runInteractive(command, updateArgs);
  await runInteractive(command, installArgs);
  return { installed: packages, missing: required.filter((name) => !commandExists(name)), pyatspi: spawnSync("python3", ["-c", "import pyatspi"], { stdio: "ignore" }).status === 0 };
}

async function ensureMacHelper(codesignIdentity = "", teamIdentifier = "") {
  const source = join(packageRoot, "native", "macos", "ComputerHelper.swift");
  const plistSource = join(packageRoot, "native", "macos", "Info.plist");
  const requestServicePlistSource = join(packageRoot, "native", "macos", "RequestService-Info.plist");
  const contentsDir = join(macAppDir, "Contents");
  const macOSDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  const requestServiceContentsDir = join(macRequestServiceDir, "Contents");
  const requestServiceMacOSDir = join(requestServiceContentsDir, "MacOS");
  const buildStamp = join(resourcesDir, "build-id");
  const identity = codesignIdentity || process.env.CHATGPT_COMPUTER_CODESIGN_IDENTITY || "-";
  const [sourceBytes, plistBytes, requestServicePlistBytes] = await Promise.all([readFile(source), readFile(plistSource), readFile(requestServicePlistSource)]);
  const buildId = createHash("sha256").update(sourceBytes).update(plistBytes).update(requestServicePlistBytes).update(identity).update(teamIdentifier).digest("hex");
  try {
    const installedBuildId = (await readFile(buildStamp, "utf8")).trim();
    const signature = spawnSync("codesign", ["--verify", "--deep", "--strict", macAppDir], { stdio: "ignore" });
    if (installedBuildId === buildId && signature.status === 0 && await canExecute(macHelperExecutable) && await canExecute(macRequestServiceExecutable)) return macHelperExecutable;
  } catch {}
  await mkdir(macOSDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });
  await mkdir(requestServiceMacOSDir, { recursive: true });
  if (!commandExists("xcrun")) {
    throw new Error("macOS native helper needs Xcode Command Line Tools. Run: xcode-select --install");
  }
  const macTargetArch = arch() === "x64" ? "x86_64" : arch();
  await runInteractive("xcrun", ["swiftc", "-target", `${macTargetArch}-apple-macos14.0`, source, "-o", macHelperExecutable, "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "ScreenCaptureKit"]);
  await runInteractive("xcrun", ["swiftc", "-D", "REQUEST_XPC_SERVICE", "-target", `${macTargetArch}-apple-macos14.0`, source, "-o", macRequestServiceExecutable, "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "ScreenCaptureKit"]);
  // Application executables must be discoverable by per-user system services
  // such as Launch Services and TCC, not only by the installing shell.
  await chmod(macHelperExecutable, 0o755);
  await chmod(macRequestServiceExecutable, 0o755);
  await copyFile(plistSource, join(contentsDir, "Info.plist"));
  await copyFile(requestServicePlistSource, join(requestServiceContentsDir, "Info.plist"));
  await writeFile(buildStamp, `${buildId}\n`, { encoding: "utf8", mode: 0o600 });
  if (!commandExists("codesign")) throw new Error("macOS code signing tool is unavailable.");
  const serviceSignArgs = ["--force", "--sign", identity, "--identifier", "com.bhrum.computer-control.request-service"];
  if (identity !== "-" && teamIdentifier) {
    serviceSignArgs.push("--requirements", `=designated => anchor apple generic and identifier \"com.bhrum.computer-control.request-service\" and certificate leaf[subject.OU] = \"${teamIdentifier}\"`);
  }
  if (identity !== "-") serviceSignArgs.push("--options", "runtime", "--timestamp");
  serviceSignArgs.push(macRequestServiceDir);
  await runInteractive("codesign", serviceSignArgs);
  const signArgs = ["--force", "--sign", identity, "--identifier", macBundleIdentifier];
  if (identity !== "-" && teamIdentifier) {
    const requirement = `designated => anchor apple generic and identifier \"${macBundleIdentifier}\" and certificate leaf[subject.OU] = \"${teamIdentifier}\"`;
    signArgs.push("--requirements", `=${requirement}`);
  }
  if (identity !== "-") signArgs.push("--options", "runtime", "--timestamp");
  signArgs.push(macAppDir);
  await runInteractive("codesign", signArgs);
  const serviceSignature = spawnSync("codesign", ["--verify", "--strict", macRequestServiceDir], { encoding: "utf8" });
  const serviceDetailsResult = spawnSync("codesign", ["-d", "--verbose=4", macRequestServiceDir], { encoding: "utf8" });
  const serviceDetails = `${serviceDetailsResult.stdout || ""}\n${serviceDetailsResult.stderr || ""}`;
  if (serviceSignature.status !== 0 || serviceDetailsResult.status !== 0 || !serviceDetails.includes("Identifier=com.bhrum.computer-control.request-service")) {
    throw new Error("The embedded macOS XPC service signature or identifier is invalid.");
  }
  if (identity !== "-") {
    const signature = spawnSync("codesign", ["-d", "--verbose=4", "-r-", macAppDir], { encoding: "utf8" });
    const details = `${signature.stdout || ""}\n${signature.stderr || ""}`;
    if (signature.status !== 0 || /Signature=adhoc|TeamIdentifier=not set/.test(details)) {
      throw new Error("Configured macOS signing identity did not produce a stable team-signed application.");
    }
    if (!details.includes(`identifier \"${macBundleIdentifier}\"`) || !details.includes("anchor apple generic")) {
      throw new Error("The signed macOS application has an unexpected designated requirement; refusing an identity-changing install.");
    }
    if (teamIdentifier && (!details.includes(`TeamIdentifier=${teamIdentifier}`) || !details.includes(`certificate leaf[subject.OU] = ${teamIdentifier}`))) {
      throw new Error("The signed macOS application does not match the configured Team ID requirement.");
    }
    if (teamIdentifier && !serviceDetails.includes(`TeamIdentifier=${teamIdentifier}`)) {
      throw new Error("The embedded macOS XPC service is not signed by the configured Team ID.");
    }
  }
  const register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (await pathExists(register)) await runInteractive(register, ["-f", macAppDir]).catch(() => {});
  return macHelperExecutable;
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
  if (platform() === "darwin") process.env.CHATGPT_COMPUTER_NATIVE_HELPER ??= macHelperExecutable;
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
  if (platform() === "darwin") {
    lines.push(`CHATGPT_COMPUTER_NATIVE_HELPER=${macHelperExecutable}`);
    const codesignIdentity = process.env.CHATGPT_COMPUTER_CODESIGN_IDENTITY || existing.CHATGPT_COMPUTER_CODESIGN_IDENTITY || "";
    if (codesignIdentity) lines.push(`CHATGPT_COMPUTER_CODESIGN_IDENTITY=${codesignIdentity}`);
    const teamIdentifier = process.env.CHATGPT_COMPUTER_TEAM_ID || existing.CHATGPT_COMPUTER_TEAM_ID || "";
    if (teamIdentifier) lines.push(`CHATGPT_COMPUTER_TEAM_ID=${teamIdentifier}`);
  }
  if (platform() === "win32") lines.push(`CHATGPT_COMPUTER_NATIVE_HELPER=${join(nativeDir, "computer-helper.ps1")}`);

  for (const key of [
    "DEVICE_GATEWAY_URL",
    "DEVICE_GATEWAY_TOKEN",
    "DEVICE_GATEWAY_TOKEN_KEYCHAIN_SERVICE",
    "DEVICE_GATEWAY_TOKEN_KEYCHAIN_ACCOUNT",
    "DEVICE_GATEWAY_IP_FAMILY",
    "DEVICE_ID",
    "DEVICE_NAME",
    "DEVICE_LOCAL_MCP_URL",
  ]) {
    if (existing[key]) lines.push(`${key}=${existing[key]}`);
  }

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
  } else if (platform() === "darwin") platformSetup = {
    helper: await ensureMacHelper(
      process.env.CHATGPT_COMPUTER_CODESIGN_IDENTITY || existing.CHATGPT_COMPUTER_CODESIGN_IDENTITY || "",
      process.env.CHATGPT_COMPUTER_TEAM_ID || existing.CHATGPT_COMPUTER_TEAM_ID || "",
    ),
    desktopMode: "native-macos",
  };
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
    for (const binary of ["xdotool", "wmctrl", "ffmpeg", "xrandr", "xdpyinfo", "xmodmap", "python3"]) push(binary, commandExists(binary));
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
    const helper = cfg.CHATGPT_COMPUTER_NATIVE_HELPER || macHelperExecutable;
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
