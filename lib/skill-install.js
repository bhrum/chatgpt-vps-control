import { access, cp, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UNIFIED_DEVICE_SKILL_NAME = "unified-device-control";

function bundledRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function codexSkillsRoot(env = process.env) {
  const codexHome = String(env.CODEX_HOME || "").trim();
  return join(codexHome ? resolve(codexHome) : join(homedir(), ".codex"), "skills");
}

export async function installUnifiedDeviceSkill({ sourceRoot = bundledRoot(), skillsRoot = codexSkillsRoot() } = {}) {
  const source = join(resolve(sourceRoot), "skills", UNIFIED_DEVICE_SKILL_NAME);
  await access(join(source, "SKILL.md"), fsConstants.R_OK);
  const contents = await readFile(join(source, "SKILL.md"), "utf8");
  if (!contents.includes(`name: ${UNIFIED_DEVICE_SKILL_NAME}`)) {
    throw new Error(`Bundled Skill metadata does not declare ${UNIFIED_DEVICE_SKILL_NAME}.`);
  }

  const destination = join(resolve(skillsRoot), UNIFIED_DEVICE_SKILL_NAME);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, force: true });
  return { source, destination, name: UNIFIED_DEVICE_SKILL_NAME };
}
