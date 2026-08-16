import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { platform } from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const skip = new Set(["node_modules", ".git", "logs"]);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
}
walk(root);

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

for (const file of files) run(process.execPath, ["--check", file], `Syntax check ${relative(root, file)}`);

if (platform() === "linux") {
  run("python3", ["-m", "py_compile", "native/linux/accessibility-helper.py"], "Linux accessibility helper syntax check");
} else if (platform() === "darwin") {
  run("xcrun", ["swiftc", "-typecheck", "native/macos/ComputerHelper.swift", "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "ScreenCaptureKit"], "macOS helper typecheck");
} else if (platform() === "win32") {
  const script = "$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('native/windows/computer-helper.ps1',[ref]$null,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }";
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], "Windows helper parse check");
}

console.log(`Checked ${files.length} JavaScript files on ${platform()}.`);
