import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";

const children = new Set();
let cleanupInstalled = false;
let sessionBusPid = null;
let accessibilityStarted = false;

function commandExists(command) {
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function displayReachable(display) {
  if (!display || !commandExists("xdpyinfo")) return false;
  return spawnSync("xdpyinfo", ["-display", display], { stdio: "ignore", timeout: 3000 }).status === 0;
}

function spawnDesktopProcess(command, args, env) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function cleanup() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  children.clear();
  if (sessionBusPid) {
    try { process.kill(sessionBusPid, "SIGTERM"); } catch {}
    sessionBusPid = null;
  }
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      cleanup();
      process.exit(signal === "SIGINT" ? 130 : 0);
    });
  }
}


function configureAccessibilityEnvironment() {
  process.env.NO_AT_BRIDGE = "0";
  if (!process.env.GTK_MODULES) process.env.GTK_MODULES = "gail:atk-bridge";
}

function ensureSessionBus() {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return;
  if (!commandExists("dbus-daemon")) return;
  const result = spawnSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return;
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const address = lines.find((line) => line.startsWith("unix:") || line.startsWith("tcp:"));
  const pid = lines.map(Number).find((value) => Number.isInteger(value) && value > 1);
  if (address) process.env.DBUS_SESSION_BUS_ADDRESS = address;
  if (pid) sessionBusPid = pid;
}

function ensureAccessibilityBus(display) {
  configureAccessibilityEnvironment();
  ensureSessionBus();
  if (accessibilityStarted || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  const launcher = "/usr/libexec/at-spi-bus-launcher";
  if (!existsSync(launcher)) return;
  installCleanup();
  spawnDesktopProcess(launcher, ["--launch-immediately"], { ...process.env, DISPLAY: display });
  accessibilityStarted = true;
}

async function waitForDisplay(display, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (displayReachable(display)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed X11 display ${display} did not become ready within ${timeoutMs}ms.`);
}

export function linuxDisplayStatus(display = process.env.DISPLAY || "") {
  if (platform() !== "linux") return { applicable: false, display: null, reachable: false };
  return { applicable: true, display: display || null, reachable: displayReachable(display) };
}

export async function ensureLinuxDesktop() {
  if (platform() !== "linux") return { mode: "native", display: null, started: false };
  const configured = process.env.DISPLAY || "";
  if (displayReachable(configured)) {
    ensureAccessibilityBus(configured);
    return { mode: "native-x11", display: configured, started: false, accessibility: accessibilityStarted };
  }

  if (process.env.COMPUTER_MANAGED_X11 !== "1") {
    throw new Error(
      `No reachable X11 display${configured ? ` at ${configured}` : ""}. Run setup again or set COMPUTER_MANAGED_X11=1 to use a managed virtual desktop.`
    );
  }

  for (const binary of ["Xvfb", "xfwm4", "xdpyinfo", "xdotool", "wmctrl", "ffmpeg"]) {
    if (!commandExists(binary)) throw new Error(`Managed Linux desktop requires ${binary}. Run setup with dependency installation enabled.`);
  }

  const display = configured || ":99";
  process.env.DISPLAY = display;
  const env = { ...process.env, DISPLAY: display };
  const screen = process.env.COMPUTER_X11_SCREEN ?? "1280x800x24";
  installCleanup();

  spawnDesktopProcess("Xvfb", [display, "-screen", "0", screen, "-ac", "+extension", "GLX", "+render", "-noreset"], env);
  await waitForDisplay(display);
  ensureAccessibilityBus(display);
  const desktopEnv = { ...process.env, DISPLAY: display };
  spawnDesktopProcess("xfwm4", ["--compositor=off"], desktopEnv);

  if (process.env.COMPUTER_ENABLE_VNC === "1" && commandExists("x11vnc")) {
    const port = process.env.COMPUTER_VNC_PORT ?? "5909";
    spawnDesktopProcess("x11vnc", ["-display", display, "-localhost", "-nopw", "-shared", "-forever", "-noxdamage", "-rfbport", port, "-quiet"], env);
  }

  return { mode: "managed-x11", display, started: true, accessibility: accessibilityStarted };
}
