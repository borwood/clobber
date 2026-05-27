import type { Database } from "bun:sqlite";
import type { Role, RoleSkill, RoleTrigger, RoleVersion, SeedRef, WakeProgram } from "@clobber/shared";
import { createRoleVersionStore } from "./role-version-store.ts";

export interface RoleEditPatch {
  readonly system_prompt?: string;
  readonly skills?: readonly RoleSkill[];
  readonly allowed_tools?: readonly string[];
  readonly triggers?: readonly RoleTrigger[];
  readonly seedRefs?: readonly SeedRef[];
  readonly wakePrograms?: readonly WakeProgram[];
}

export interface EditRoleResult {
  readonly role_id: string;
  readonly version_id: string;
  readonly version: number;
}

export function editRole(
  db: Database,
  role: Role,
  currentVersion: RoleVersion,
  patch: RoleEditPatch,
): EditRoleResult {
  const versions = createRoleVersionStore(db);

  const setCurrentVersion = db.prepare(
    "UPDATE roles SET current_version_id = ? WHERE id = ?",
  );

  const maxRow = db
    .prepare("SELECT MAX(version) AS max FROM role_versions WHERE role_id = ?")
    .get(role.id) as { max: number | null };
  const nextVersion = (maxRow.max ?? 0) + 1;

  const newSystemPrompt =
    patch.system_prompt === undefined
      ? currentVersion.system_prompt
      : patch.system_prompt;

  const newSkillsJson =
    patch.skills === undefined
      ? currentVersion.skills_json
      : JSON.stringify(patch.skills);

  const newAllowedToolsJson =
    patch.allowed_tools === undefined
      ? currentVersion.allowed_tools_json
      : JSON.stringify(patch.allowed_tools);

  const newTriggersJson =
    patch.triggers === undefined
      ? currentVersion.triggers_json
      : JSON.stringify(patch.triggers);

  const newSeedRefsJson =
    patch.seedRefs === undefined
      ? currentVersion.seed_refs_json
      : JSON.stringify(patch.seedRefs);

  const newWakeProgramsJson =
    patch.wakePrograms === undefined
      ? currentVersion.wake_programs_json
      : JSON.stringify(patch.wakePrograms);

  const created = versions.create({
    role_id: role.id,
    version: nextVersion,
    framing: currentVersion.framing,
    system_prompt: newSystemPrompt,
    skills_json: newSkillsJson,
    allowed_tools_json: newAllowedToolsJson,
    allowed_cli_commands_json: currentVersion.allowed_cli_commands_json,
    hooks_json: currentVersion.hooks_json,
    triggers_json: newTriggersJson,
    seed_refs_json: newSeedRefsJson,
    wake_programs_json: newWakeProgramsJson,
  });

  setCurrentVersion.run(created.id, role.id);

  return { role_id: role.id, version_id: created.id, version: nextVersion };
}
