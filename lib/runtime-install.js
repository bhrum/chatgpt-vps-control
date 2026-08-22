import { createHash } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const RUNTIME_ENTRIES = [
  "bin",
  "extension",
  "lib",
  "native",
  "scripts",
  "skills",
  "computer-use.js",
  "server.js",
  "package.json",
  "package-lock.json",
  "node_modules",
];

const HASH_ENTRIES = RUNTIME_ENTRIES.filter((entry) => entry !== "node_modules");
const RUNTIME_LAYOUT_VERSION = 1;
const REQUIRED_RUNTIME_PATHS = [
  "bin/chatgpt-computer-control.js",
  "scripts/browser-extension-host.mjs",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/ws/package.json",
  "node_modules/zod/package.json",
];

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithin(parent, candidate) {
  const child = relative(resolve(parent), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function hashEntry(hash, sourceRoot, relativePath) {
  const absolutePath = join(sourceRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    hash.update(`L\0${relativePath}\0${await readlink(absolutePath)}\0`);
    return;
  }
  if (metadata.isDirectory()) {
    hash.update(`D\0${relativePath}\0`);
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".DS_Store") continue;
      await hashEntry(hash, sourceRoot, join(relativePath, entry.name));
    }
    return;
  }
  if (!metadata.isFile()) return;
  hash.update(`F\0${relativePath}\0${metadata.mode & 0o777}\0`);
  hash.update(await readFile(absolutePath));
  hash.update("\0");
}

async function runtimeIdentity(sourceRoot) {
  const hash = createHash("sha256");
  hash.update(`chatgpt-computer-control-runtime-v${RUNTIME_LAYOUT_VERSION}\0`);
  for (const entry of HASH_ENTRIES) await hashEntry(hash, sourceRoot, entry);
  return hash.digest("hex");
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function runtimeIsComplete(root) {
  for (const entry of RUNTIME_ENTRIES) if (!await pathExists(join(root, entry))) return false;
  for (const relativePath of REQUIRED_RUNTIME_PATHS) if (!await pathExists(join(root, relativePath))) return false;
  return true;
}

function runtimeResult(root, runtimeId, reused) {
  return {
    root,
    runtimeId,
    reused,
    cliPath: join(root, "bin", "chatgpt-computer-control.js"),
    browserHostPath: join(root, "scripts", "browser-extension-host.mjs"),
  };
}

/**
 * Copy the executable Node runtime out of a checkout (commonly under macOS
 * Documents) into the connector's private application-data directory. The
 * background service and Chrome native host must execute this staged copy so
 * macOS does not repeatedly attribute protected-folder reads to `node`.
 */
export async function installPrivateRuntime({ sourceRoot, appHome }) {
  const resolvedSource = resolve(sourceRoot);
  const runtimeBase = resolve(appHome, "runtime");
  await mkdir(runtimeBase, { recursive: true, mode: 0o700 });
  await chmod(runtimeBase, 0o700).catch(() => {});

  // A service already running from a staged bundle can reuse itself without
  // copying or replacing files beneath its active module graph.
  if (isWithin(runtimeBase, resolvedSource)) {
    const manifest = await readManifest(join(resolvedSource, "runtime-manifest.json"));
    if (!manifest?.runtimeId || !await runtimeIsComplete(resolvedSource)) {
      throw new Error(`Cannot reuse incomplete private runtime: ${resolvedSource}. Reinstall from the source checkout.`);
    }
    return runtimeResult(resolvedSource, String(manifest?.runtimeId || "installed"), true);
  }

  for (const entry of RUNTIME_ENTRIES) {
    if (!await pathExists(join(resolvedSource, entry))) {
      throw new Error(`Cannot install private runtime: missing ${entry} in ${resolvedSource}.`);
    }
  }

  const sourceHash = await runtimeIdentity(resolvedSource);
  const runtimeId = `v${RUNTIME_LAYOUT_VERSION}-${sourceHash.slice(0, 20)}`;
  const destination = join(runtimeBase, runtimeId);
  const manifestPath = join(destination, "runtime-manifest.json");
  const existing = await readManifest(manifestPath);
  if (existing?.sourceHash === sourceHash && await runtimeIsComplete(destination)) {
    return runtimeResult(destination, runtimeId, true);
  }

  const staging = await mkdtemp(join(runtimeBase, ".stage-"));
  try {
    for (const entry of RUNTIME_ENTRIES) {
      await cp(join(resolvedSource, entry), join(staging, entry), {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
    }
    if (await runtimeIdentity(staging) !== sourceHash) {
      throw new Error("Cannot install private runtime: source files changed while they were being staged; retry the install.");
    }
    await chmod(join(staging, "bin", "chatgpt-computer-control.js"), 0o700).catch(() => {});
    await chmod(join(staging, "scripts", "browser-extension-host.mjs"), 0o700).catch(() => {});
    await writeFile(join(staging, "runtime-manifest.json"), `${JSON.stringify({
      layoutVersion: RUNTIME_LAYOUT_VERSION,
      runtimeId,
      sourceHash,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    // A deterministic content-addressed destination is safe to replace only
    // when a prior interrupted install left it without a valid manifest.
    if (await pathExists(destination)) await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return runtimeResult(destination, runtimeId, false);
}

export const privateRuntimeEntries = Object.freeze([...RUNTIME_ENTRIES]);
