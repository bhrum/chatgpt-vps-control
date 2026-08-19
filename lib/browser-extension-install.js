import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NATIVE_HOST_NAME, browserExtensionPaths } from "./browser-extension-paths.js";
import { installLocalRuntime } from "./local-install.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function extensionIdFromPublicKey(publicKey) {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function nativeManifestDestinations(currentPlatform = platform()) {
  const home = homedir();
  if (process.env.COMPUTER_BROWSER_NATIVE_MANIFEST_DIR) {
    return [{ browser: "custom", directory: resolve(process.env.COMPUTER_BROWSER_NATIVE_MANIFEST_DIR) }];
  }
  if (currentPlatform === "darwin") return [
    { browser: "chrome", directory: join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts") },
    { browser: "chromium", directory: join(home, "Library/Application Support/Chromium/NativeMessagingHosts") },
    { browser: "edge", directory: join(home, "Library/Application Support/Microsoft Edge/NativeMessagingHosts") },
  ];
  if (currentPlatform === "linux") return [
    { browser: "chrome", directory: join(home, ".config/google-chrome/NativeMessagingHosts") },
    { browser: "chromium", directory: join(home, ".config/chromium/NativeMessagingHosts") },
    { browser: "edge", directory: join(home, ".config/microsoft-edge/NativeMessagingHosts") },
  ];
  return [{ browser: "windows", directory: browserExtensionPaths().home }];
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function ensureSecret(path) {
  try {
    const current = (await readFile(path, "utf8")).trim();
    if (current.length >= 32) return current;
  } catch {}
  const secret = randomBytes(32).toString("base64url");
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

async function installWindowsRegistry(manifestPath) {
  for (const key of [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  ]) await execFileAsync("reg.exe", ["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
}

export async function installBrowserExtension({ currentPlatform = platform(), manifestDestinations, runtimeInstaller = installLocalRuntime } = {}) {
  const paths = browserExtensionPaths();
  const runtime = await runtimeInstaller();
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await ensureSecret(paths.secret);
  let metadata = await readJson(paths.metadata);
  if (!metadata?.publicKey) {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    metadata = { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  }
  metadata.extensionId = extensionIdFromPublicKey(metadata.publicKey);
  metadata.installedAt = new Date().toISOString();

  await cp(join(runtime.root || packageRoot, "extension"), paths.extension, { recursive: true, force: true });
  const extensionManifestPath = join(paths.extension, "manifest.json");
  const extensionManifest = JSON.parse(await readFile(extensionManifestPath, "utf8"));
  extensionManifest.key = metadata.publicKey;
  await writeFile(extensionManifestPath, `${JSON.stringify(extensionManifest, null, 2)}\n`, { mode: 0o600 });

  // Chrome can start this host long after setup completes. Point it at the
  // private staged runtime rather than a checkout under Desktop/Documents so
  // macOS does not repeatedly ask `node` for protected-folder access.
  const hostScript = runtime.browserHostPath;
  if (currentPlatform === "win32") {
    await writeFile(paths.launcher, `@echo off\r\nset "COMPUTER_BROWSER_EXTENSION_HOME=${paths.home}"\r\n"${process.execPath}" "${hostScript}"\r\n`, { mode: 0o700 });
  } else {
    await writeFile(paths.launcher, `#!/bin/sh\nexport COMPUTER_BROWSER_EXTENSION_HOME=${shellQuote(paths.home)}\nexec ${shellQuote(process.execPath)} ${shellQuote(hostScript)}\n`, { mode: 0o700 });
    await chmod(paths.launcher, 0o700);
  }
  const nativeManifest = {
    name: NATIVE_HOST_NAME,
    description: "Local bridge for ChatGPT Computer Control",
    path: paths.launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${metadata.extensionId}/`],
  };
  await writeFile(paths.manifest, `${JSON.stringify(nativeManifest, null, 2)}\n`, { mode: 0o600 });
  const destinations = manifestDestinations || nativeManifestDestinations(currentPlatform);
  const installedManifests = [];
  for (const destination of destinations) {
    await mkdir(destination.directory, { recursive: true, mode: 0o700 });
    const target = join(destination.directory, `${NATIVE_HOST_NAME}.json`);
    await writeFile(target, `${JSON.stringify(nativeManifest, null, 2)}\n`, { mode: 0o600 });
    installedManifests.push({ browser: destination.browser, path: target });
  }
  if (currentPlatform === "win32" && !manifestDestinations && !process.env.COMPUTER_BROWSER_NATIVE_MANIFEST_DIR) await installWindowsRegistry(paths.manifest);
  await writeFile(paths.metadata, `${JSON.stringify({ ...metadata, manifests: installedManifests }, null, 2)}\n`, { mode: 0o600 });
  return { ...paths, extensionId: metadata.extensionId, manifests: installedManifests, runtime: runtime.root ?? null };
}

export async function browserExtensionStatus() {
  const paths = browserExtensionPaths();
  const metadata = await readJson(paths.metadata);
  const manifest = await readJson(join(paths.extension, "manifest.json"));
  return {
    installed: Boolean(metadata?.extensionId && manifest?.key),
    extensionId: metadata?.extensionId ?? null,
    extensionPath: paths.extension,
    manifests: metadata?.manifests ?? [],
  };
}
