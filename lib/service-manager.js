import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { appHome, envPath } from "./local-install.js";

const cliPath = fileURLToPath(new URL("../bin/chatgpt-computer-control.js", import.meta.url));

function run(command, args, { capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
    const stdout = [];
    const stderr = [];
    if (capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code !== 0) return rejectRun(new Error(`${command} exited with ${code}${capture ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : ""}`));
      resolveRun(capture ? Buffer.concat(stdout).toString("utf8") : "");
    });
  });
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

async function installLinuxUserService() {
  const target = join(homedir(), ".config", "systemd", "user", "chatgpt-computer-control.service");
  await mkdir(dirname(target), { recursive: true });
  const node = process.execPath;
  const content = `[Unit]\nDescription=ChatGPT Computer Control MCP\nAfter=graphical-session.target network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironmentFile=${envPath}\nExecStart=${node} ${cliPath} serve\nRestart=on-failure\nRestartSec=2\nWorkingDirectory=${appHome}\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", "chatgpt-computer-control.service"]);
  return { manager: "systemd-user", path: target };
}

async function installMacLaunchAgent() {
  const target = join(homedir(), "Library", "LaunchAgents", "com.chatgpt.computer-control.plist");
  await mkdir(dirname(target), { recursive: true });
  const logDir = join(appHome, "logs");
  await mkdir(logDir, { recursive: true });
  const args = [process.execPath, cliPath, "serve"];
  const argumentXml = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.chatgpt.computer-control</string>\n  <key>ProgramArguments</key><array>\n${argumentXml}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>WorkingDirectory</key><string>${xmlEscape(appHome)}</string>\n  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "server-out.log"))}</string>\n  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "server-err.log"))}</string>\n</dict>\n</plist>\n`;
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  await run("launchctl", ["bootout", `gui/${process.getuid()}`, target], { capture: true }).catch(() => {});
  await run("launchctl", ["bootstrap", `gui/${process.getuid()}`, target]);
  return { manager: "launchd", path: target };
}

async function installWindowsTask() {
  const taskName = "ChatGPTComputerControl";
  const node = process.execPath.replace(/'/g, "''");
  const cli = cliPath.replace(/'/g, "''");
  const command = `& '${node}' '${cli}' serve`;
  const escaped = command.replace(/"/g, '\\"');
  const ps = `$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command \"${escaped}\"'; $trigger=New-ScheduledTaskTrigger -AtLogOn; Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Description 'ChatGPT Computer Control MCP' -Force | Out-Null; Start-ScheduledTask -TaskName '${taskName}'`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps]);
  return { manager: "scheduled-task", name: taskName };
}

export async function installService() {
  if (platform() === "linux") return installLinuxUserService();
  if (platform() === "darwin") return installMacLaunchAgent();
  if (platform() === "win32") return installWindowsTask();
  throw new Error(`Unsupported platform: ${platform()}`);
}

export async function removeService() {
  if (platform() === "linux") {
    await run("systemctl", ["--user", "disable", "--now", "chatgpt-computer-control.service"], { capture: true }).catch(() => {});
    return;
  }
  if (platform() === "darwin") {
    const target = join(homedir(), "Library", "LaunchAgents", "com.chatgpt.computer-control.plist");
    await run("launchctl", ["bootout", `gui/${process.getuid()}`, target], { capture: true }).catch(() => {});
    return;
  }
  if (platform() === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Unregister-ScheduledTask -TaskName 'ChatGPTComputerControl' -Confirm:$false -ErrorAction SilentlyContinue"], { capture: true }).catch(() => {});
    return;
  }
}
