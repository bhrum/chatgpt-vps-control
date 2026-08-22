import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installPrivateRuntime, privateRuntimeEntries } from "../lib/runtime-install.js";

async function writeFixture(path, value = "fixture\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function createRuntimeSource(root) {
  const directoryEntries = new Set(["bin", "extension", "lib", "native", "scripts", "skills", "node_modules"]);
  for (const entry of privateRuntimeEntries) {
    if (directoryEntries.has(entry)) await mkdir(join(root, entry), { recursive: true });
    else await writeFixture(join(root, entry), entry === "package.json" ? '{"name":"fixture","version":"1.0.0"}\n' : `${entry}\n`);
  }
  await writeFixture(join(root, "bin", "chatgpt-computer-control.js"), "#!/usr/bin/env node\n");
  await writeFixture(join(root, "scripts", "browser-extension-host.mjs"), "export {};\n");
  await writeFixture(join(root, "lib", "entry.js"), "export const fixture = true;\n");
  await writeFixture(join(root, "native", "helper.txt"));
  await writeFixture(join(root, "extension", "manifest.json"), "{}\n");
  await writeFixture(join(root, "skills", "unified-device-control", "SKILL.md"), "---\nname: unified-device-control\n---\n");
  await writeFixture(join(root, "node_modules", ".package-lock.json"), "{}\n");
  for (const dependency of ["@modelcontextprotocol/sdk", "ws", "zod"]) {
    await writeFixture(join(root, "node_modules", dependency, "package.json"), `{"name":"${dependency}"}\n`);
  }
}

test("private runtime is content-addressed, reusable, and outside the source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "computer-private-runtime-"));
  const sourceRoot = join(root, "Documents", "checkout");
  const appHome = join(root, "app-home");
  try {
    await createRuntimeSource(sourceRoot);
    const first = await installPrivateRuntime({ sourceRoot, appHome });
    assert.equal(first.reused, false);
    assert.ok(first.root.startsWith(join(appHome, "runtime")));
    assert.ok(!first.cliPath.startsWith(sourceRoot));
    assert.equal(await readFile(first.cliPath, "utf8"), "#!/usr/bin/env node\n");

    const manifest = JSON.parse(await readFile(join(first.root, "runtime-manifest.json"), "utf8"));
    assert.equal(manifest.runtimeId, first.runtimeId);
    assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/);

    const second = await installPrivateRuntime({ sourceRoot, appHome });
    assert.equal(second.root, first.root);
    assert.equal(second.reused, true);

    await writeFile(join(sourceRoot, "server.js"), "changed\n");
    const third = await installPrivateRuntime({ sourceRoot, appHome });
    assert.notEqual(third.root, first.root);
    assert.equal(await readFile(join(third.root, "server.js"), "utf8"), "changed\n");

    await rm(join(third.root, "node_modules", "zod", "package.json"));
    const repaired = await installPrivateRuntime({ sourceRoot, appHome });
    assert.equal(repaired.root, third.root);
    assert.equal(repaired.reused, false);
    assert.equal(JSON.parse(await readFile(join(repaired.root, "node_modules", "zod", "package.json"), "utf8")).name, "zod");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed runtime reuses itself instead of replacing its active files", async () => {
  const root = await mkdtemp(join(tmpdir(), "computer-installed-runtime-"));
  const sourceRoot = join(root, "source");
  const appHome = join(root, "app-home");
  try {
    await createRuntimeSource(sourceRoot);
    const installed = await installPrivateRuntime({ sourceRoot, appHome });
    const reused = await installPrivateRuntime({ sourceRoot: installed.root, appHome });
    assert.equal(reused.root, installed.root);
    assert.equal(reused.reused, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
