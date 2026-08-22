import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSkillsRoot, installUnifiedDeviceSkill } from "../lib/skill-install.js";

test("codexSkillsRoot honors CODEX_HOME", () => {
  assert.equal(codexSkillsRoot({ CODEX_HOME: "/tmp/task-codex-home" }), "/tmp/task-codex-home/skills");
});

test("installs the bundled unified device Skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-device-skill-"));
  const sourceRoot = join(root, "runtime");
  const skillsRoot = join(root, "codex-skills");
  const source = join(sourceRoot, "skills", "unified-device-control");
  try {
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: unified-device-control\n---\n");
    await writeFile(join(source, "references", "routing.md"), "route\n");
    const installed = await installUnifiedDeviceSkill({ sourceRoot, skillsRoot });
    assert.equal(installed.destination, join(skillsRoot, "unified-device-control"));
    assert.match(await readFile(join(installed.destination, "SKILL.md"), "utf8"), /unified-device-control/);
    assert.equal(await readFile(join(installed.destination, "references", "routing.md"), "utf8"), "route\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
