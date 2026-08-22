import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { appHome, envPath, installLocalRuntime, syncMacGatewayTokenFallback } from "./local-install.js";

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

function appleScriptString(value) {
  return `"${String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

async function runMacPrivilegedShell(command) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await run("/bin/sh", ["-c", command]);
    return;
  }
  await run("/usr/bin/osascript", ["-e", `do shell script ${appleScriptString(command)} with administrator privileges`]);
}

export function macPresenceDaemonPlist(cliPath, { username = userInfo().username, home = homedir(), node = existsSync("/usr/local/bin/node") ? "/usr/local/bin/node" : process.execPath } = {}) {
  if (!/^[A-Za-z0-9._-]+$/u.test(username)) throw new Error("macOS presence service username is invalid.");
  const logDir = join(appHome, "logs");
  const args = [node, cliPath, "presence"];
  const argumentXml = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.chatgpt.computer-control.presence</string>\n  <key>ProgramArguments</key><array>\n${argumentXml}\n  </array>\n  <key>UserName</key><string>${xmlEscape(username)}</string>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>ThrottleInterval</key><integer>5</integer>\n  <key>WorkingDirectory</key><string>${xmlEscape(appHome)}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key><string>${xmlEscape(home)}</string>\n    <key>USER</key><string>${xmlEscape(username)}</string>\n    <key>PRESENCE_DESKTOP_USER</key><string>${xmlEscape(username)}</string>\n    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n  </dict>\n  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "presence-out.log"))}</string>\n  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "presence-err.log"))}</string>\n</dict>\n</plist>\n`;
}

async function installMacPresenceDaemon(cliPath) {
  const label = "com.chatgpt.computer-control.presence";
  const target = `/Library/LaunchDaemons/${label}.plist`;
  const staged = join(appHome, `${label}.plist`);
  await syncMacGatewayTokenFallback();
  await mkdir(join(appHome, "logs"), { recursive: true });
  await writeFile(staged, macPresenceDaemonPlist(cliPath), { encoding: "utf8", mode: 0o600 });
  const install = `/usr/bin/install -o root -g wheel -m 644 '${staged.replace(/'/gu, "'\\''")}' '${target}'`;
  const reload = `/bin/launchctl bootout system/${label} >/dev/null 2>&1 || true; /bin/launchctl bootstrap system '${target}'; /bin/launchctl enable system/${label}; /bin/launchctl kickstart -k system/${label}`;
  await runMacPrivilegedShell(`${install}; ${reload}`);
  return { path: target, staged };
}

async function installLinuxUserService(cliPath) {
  const target = join(homedir(), ".config", "systemd", "user", "chatgpt-computer-control.service");
  await mkdir(dirname(target), { recursive: true });
  const node = process.execPath;
  const content = `[Unit]\nDescription=ChatGPT Computer Control MCP\nAfter=graphical-session.target network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironmentFile=${envPath}\nExecStart=${node} ${cliPath} serve\nRestart=on-failure\nRestartSec=2\nWorkingDirectory=${appHome}\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", "chatgpt-computer-control.service"]);
  return { manager: "systemd-user", path: target };
}

async function installMacLaunchAgent(cliPath) {
  const target = join(homedir(), "Library", "LaunchAgents", "com.chatgpt.computer-control.plist");
  await mkdir(dirname(target), { recursive: true });
  const logDir = join(appHome, "logs");
  await mkdir(logDir, { recursive: true });
  const node = existsSync("/usr/local/bin/node") ? "/usr/local/bin/node" : process.execPath;
  const args = [node, cliPath, "serve"];
  const argumentXml = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.chatgpt.computer-control</string>\n  <key>ProgramArguments</key><array>\n${argumentXml}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>ThrottleInterval</key><integer>5</integer>\n  <key>WorkingDirectory</key><string>${xmlEscape(appHome)}</string>\n  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "server-out.log"))}</string>\n  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "server-err.log"))}</string>\n</dict>\n</plist>\n`;
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  await run("launchctl", ["bootout", `${domain}/com.chatgpt.computer-control`], { capture: true }).catch(() => {});
  // launchd can briefly retain the old job after bootout and return EIO from
  // an immediate bootstrap. A bounded retry makes upgrades deterministic.
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  await run("launchctl", ["bootstrap", domain, target]).catch(async (firstError) => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    try {
      await run("launchctl", ["bootstrap", domain, target]);
    } catch {
      throw firstError;
    }
  });
  await run("launchctl", ["enable", `${domain}/com.chatgpt.computer-control`]);
  await run("launchctl", ["kickstart", "-k", `${domain}/com.chatgpt.computer-control`]);
  return { manager: "launchd", path: target };
}

async function installWindowsTask(cliPath) {
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
  const runtime = await installLocalRuntime();
  let result;
  if (platform() === "linux") result = await installLinuxUserService(runtime.cliPath);
  else if (platform() === "darwin") {
    result = await installMacLaunchAgent(runtime.cliPath);
    result.presence = await installMacPresenceDaemon(runtime.cliPath);
  }
  else if (platform() === "win32") result = await installWindowsTask(runtime.cliPath);
  else throw new Error(`Unsupported platform: ${platform()}`);
  return { ...result, runtime: runtime.root, runtimeId: runtime.runtimeId };
}

export async function removeService() {
  if (platform() === "linux") {
    await run("systemctl", ["--user", "disable", "--now", "chatgpt-computer-control.service"], { capture: true }).catch(() => {});
    return;
  }
  if (platform() === "darwin") {
    const target = join(homedir(), "Library", "LaunchAgents", "com.chatgpt.computer-control.plist");
    await run("launchctl", ["bootout", `gui/${process.getuid()}`, target], { capture: true }).catch(() => {});
    const label = "com.chatgpt.computer-control.presence";
    await runMacPrivilegedShell(`/bin/launchctl bootout system/${label} >/dev/null 2>&1 || true; /bin/rm -f '/Library/LaunchDaemons/${label}.plist'`);
    return;
  }
  if (platform() === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Unregister-ScheduledTask -TaskName 'ChatGPTComputerControl' -Confirm:$false -ErrorAction SilentlyContinue"], { capture: true }).catch(() => {});
    return;
  }
}
