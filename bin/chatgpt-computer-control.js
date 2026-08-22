#!/usr/bin/env node
import { platform } from "node:os";
import { applyLocalConfig, doctorLocalComputer, readLocalConfig, setupLocalComputer } from "../lib/local-install.js";
import { installService, removeService } from "../lib/service-manager.js";
import { ensureLinuxDesktop } from "../lib/linux-desktop.js";
import { browserExtensionStatus, installBrowserExtension } from "../lib/browser-extension-install.js";
import { startMacPresenceAgent } from "../lib/macos-presence-agent.js";
import { installUnifiedDeviceSkill } from "../lib/skill-install.js";

function printUsage() {
  console.log(`ChatGPT Computer Control\n\nUsage:\n  chatgpt-computer-control setup [--no-deps] [--host 127.0.0.1] [--port 8787]\n  chatgpt-computer-control doctor\n  chatgpt-computer-control serve\n  chatgpt-computer-control presence\n  chatgpt-computer-control service install\n  chatgpt-computer-control service remove\n  chatgpt-computer-control browser-extension install\n  chatgpt-computer-control browser-extension status\n  chatgpt-computer-control skill install\n  chatgpt-computer-control url\n\nThe MCP server binds to loopback by default. Expose it only through an authenticated HTTPS tunnel or another trusted transport.`);
}

function valueAfter(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

async function setup(args) {
  const host = valueAfter(args, "--host", "127.0.0.1");
  const port = Number(valueAfter(args, "--port", "8787"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535.");
  const result = await setupLocalComputer({ installDependencies: !args.includes("--no-deps"), host, port });
  const skill = await installUnifiedDeviceSkill();
  console.log(`Configured ChatGPT Computer Control for ${result.platform}.`);
  console.log(`Home: ${result.home}`);
  console.log(`MCP URL (local): ${result.mcpUrl}`);
  console.log(`Codex Skill: ${skill.destination}`);
  if (platform() === "darwin") {
    console.log("macOS requires Accessibility and Screen Recording permission for the installed ChatGPT Computer Control app. Run doctor, then grant that named app in System Settings.");
  }
  if (platform() === "win32") {
    console.log("Windows control runs in the signed-in interactive desktop. UAC secure desktop and locked sessions are intentionally outside normal automation.");
  }
  console.log("Next: chatgpt-computer-control doctor");
  console.log("Then: chatgpt-computer-control service install");
}

async function doctor() {
  const result = await doctorLocalComputer();
  console.log(`Platform: ${result.platform}`);
  console.log(`Home: ${result.home}`);
  for (const check of result.checks) {
    console.log(`${check.ok ? "OK" : "FAIL"}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  if (!result.ok) process.exitCode = 2;
}

async function serve() {
  await applyLocalConfig();
  if (!process.env.VPS_APP_TOKEN || process.env.VPS_APP_TOKEN.length < 24) {
    throw new Error("Computer control is not configured. Run: chatgpt-computer-control setup");
  }
  if (platform() === "linux") {
    const desktop = await ensureLinuxDesktop();
    console.log(`Computer desktop backend: ${desktop.mode}${desktop.display ? ` (${desktop.display})` : ""}`);
  }
  await import("../server.js");
}

async function presence() {
  await applyLocalConfig();
  const agent = startMacPresenceAgent();
  const stop = () => {
    agent.stop();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function printUrl() {
  const cfg = await readLocalConfig();
  if (!cfg.VPS_APP_TOKEN) throw new Error("Not configured. Run setup first.");
  const host = cfg.HOST || "127.0.0.1";
  const port = cfg.PORT || "8787";
  const prefix = cfg.MCP_PATH_PREFIX || "/mcp";
  console.log(`http://${host}:${port}${prefix}/${cfg.VPS_APP_TOKEN}`);
}

async function browserExtension(command) {
  if (command === "install") {
    const result = await installBrowserExtension();
    console.log("Browser bridge installed.");
    console.log(`Extension ID: ${result.extensionId}`);
    if (result.runtime) console.log(`Private runtime: ${result.runtime}`);
    console.log("1. Open chrome://extensions and enable Developer mode.");
    console.log(`2. Choose Load unpacked and select: ${result.extension}`);
    console.log("3. Keep the local service running. The MCP can now enumerate ordinary tabs and atomically claim the exact selected tab.");
    return;
  }
  if (command === "status") {
    const result = await browserExtensionStatus();
    console.log(result.installed ? "Browser bridge files: installed" : "Browser bridge files: not installed");
    console.log(`Extension path: ${result.extensionPath}`);
    if (result.extensionId) console.log(`Extension ID: ${result.extensionId}`);
    return;
  }
  throw new Error("Use: chatgpt-computer-control browser-extension install|status");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  if (["help", "-h", "--help"].includes(command)) return printUsage();
  if (command === "setup") return setup(args.slice(1));
  if (command === "doctor") return doctor();
  if (command === "serve") return serve();
  if (command === "presence") return presence();
  if (command === "url") return printUrl();
  if (command === "browser-extension") return browserExtension(args[1]);
  if (command === "skill" && args[1] === "install") {
    const result = await installUnifiedDeviceSkill();
    console.log(`Installed Codex Skill: ${result.destination}`);
    return;
  }
  if (command === "service" && args[1] === "install") {
    await applyLocalConfig();
    const result = await installService();
    console.log(`Installed and started service using ${result.manager}.`);
    console.log(`Private runtime: ${result.runtime}`);
    return;
  }
  if (command === "service" && args[1] === "remove") {
    await removeService();
    console.log("Removed/stopped the background service.");
    return;
  }
  printUsage();
  throw new Error(`Unknown command: ${args.join(" ")}`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
