import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_HOOKS_REL, type LoadedRole } from "@clobber/runtime";
import type { RoleSkill } from "@clobber/shared";

export interface RoleVersionSnapshot {
  readonly framing: string;
  readonly system_prompt: string;
  readonly skills_json: string;
  readonly allowed_tools_json: string;
  readonly allowed_cli_commands_json: string;
  readonly hooks_json: string;
  readonly triggers_json: string;
  readonly seed_refs_json: string;
}

export interface SnapshotInputs {
  readonly loaded: LoadedRole;
  readonly allowedTools: readonly string[];
}

export function snapshotShippedBundle(inputs: SnapshotInputs): RoleVersionSnapshot {
  const { loaded, allowedTools } = inputs;
  const pluginRoot = join(loaded.bundleRoot, loaded.manifest.pluginTemplatePath);

  const skills = readSkills(join(pluginRoot, "skills"));
  const hooksAbs = join(pluginRoot, PLUGIN_HOOKS_REL);
  const hooks_json = readFileSync(hooksAbs, "utf8");

  return {
    framing: loaded.framing,
    system_prompt: loaded.systemPrompt,
    skills_json: JSON.stringify(skills),
    allowed_tools_json: JSON.stringify(allowedTools),
    allowed_cli_commands_json: JSON.stringify([
      ...loaded.manifest.allowedCliCommands,
    ]),
    hooks_json,
    triggers_json: "[]",
    seed_refs_json: JSON.stringify(loaded.manifest.seedRefs ?? []),
  };
}

function readSkills(skillsDir: string): readonly RoleSkill[] {
  const out: RoleSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    out.push({ name: entry.name, body: readFileSync(skillFile, "utf8") });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
