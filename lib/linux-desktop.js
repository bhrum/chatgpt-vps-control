import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

const children = new Set();
let cleanupInstalled = false;

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
  if (displayReachable(configured)) return { mode: "native-x11", display: configured, started: false };

  if (process.env.COMPUTER_MANAGED_X11 !== "1") {
    throw new Error(
      `No reachable X11 display${configured ? ` at ${configured}` : ""}. Run setup again or set COMPUTER_MANAGED_X11=1 to use a managed virtual desktop.`
    );
  }

  for (const binary of ["Xvfb", "xfwm4", "xdpyinfo", "xdotool", "ffmpeg"]) {
    if (!commandExists(binary)) throw new Error(`Managed Linux desktop requires ${binary}. Run setup with dependency installation enabled.`);
  }

  const display = configured || ":99";
  process.env.DISPLAY = display;
  const env = { ...process.env, DISPLAY: display };
  const screen = process.env.COMPUTER_X11_SCREEN ?? "1280x800x24";
  installCleanup();

  spawnDesktopProcess("Xvfb", [display, "-screen", "0", screen, "-ac", "+extension", "GLX", "+render", "-noreset"], env);
  await waitForDisplay(display);
  spawnDesktopProcess("xfwm4", ["--compositor=off"], env);

  if (process.env.COMPUTER_ENABLE_VNC === "1" && commandExists("x11vnc")) {
    const port = process.env.COMPUTER_VNC_PORT ?? "5909";
    spawnDesktopProcess("x11vnc", ["-display", display, "-localhost", "-nopw", "-shared", "-forever", "-noxdamage", "-rfbport", port, "-quiet"], env);
  }

  return { mode: "managed-x11", display, started: true };
}
