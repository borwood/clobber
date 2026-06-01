import type { Database } from "bun:sqlite";
import type {
  Role,
  RoleSkill,
  RoleTrigger,
  RoleVersion,
  SeedRef,
  WakeProgram,
} from "@clobber/shared";
import { createRoleVersionStore } from "../src/role-version-store.ts";

// #414 test fixture — write a new role_versions row and point the role at it,
// WITHOUT touching the commit pin. Production retired the version-row WRITE path
// (it demoted git-backed roles, the #396 violation); version ROWS still persist
// as retained history (forward-only, #412). These scheduler / seeds / wake-program
// / prompt-composition tests exercise row-backed roles, so they set up content
// through this helper instead of the deleted `editRole`. It is the old write
// minus the pin-NULL — never demotes, never advances a pin.

export interface RoleVersionPatch {
  readonly system_prompt?: string;
  readonly skills?: readonly RoleSkill[];
  readonly allowed_tools?: readonly string[];
  readonly triggers?: readonly RoleTrigger[];
  readonly seedRefs?: readonly SeedRef[];
  readonly wakePrograms?: readonly WakeProgram[];
}

export function writeRoleVersion(
  db: Database,
  role: Role,
  currentVersion: RoleVersion,
  patch: RoleVersionPatch,
): { role_id: string; version_id: string; version: number } {
  const versions = createRoleVersionStore(db);

  const maxRow = db
    .prepare("SELECT MAX(version) AS max FROM role_versions WHERE role_id = ?")
    .get(role.id) as { max: number | null };
  const nextVersion = (maxRow.max ?? 0) + 1;

  const created = versions.create({
    role_id: role.id,
    version: nextVersion,
    framing: currentVersion.framing,
    system_prompt:
      patch.system_prompt === undefined ? currentVersion.system_prompt : patch.system_prompt,
    skills_json:
      patch.skills === undefined ? currentVersion.skills_json : JSON.stringify(patch.skills),
    allowed_tools_json:
      patch.allowed_tools === undefined
        ? currentVersion.allowed_tools_json
        : JSON.stringify(patch.allowed_tools),
    allowed_cli_commands_json: currentVersion.allowed_cli_commands_json,
    hooks_json: currentVersion.hooks_json,
    triggers_json:
      patch.triggers === undefined ? currentVersion.triggers_json : JSON.stringify(patch.triggers),
    seed_refs_json:
      patch.seedRefs === undefined ? currentVersion.seed_refs_json : JSON.stringify(patch.seedRefs),
    wake_programs_json:
      patch.wakePrograms === undefined
        ? currentVersion.wake_programs_json
        : JSON.stringify(patch.wakePrograms),
    default_wake_program: currentVersion.default_wake_program,
  });

  // Only the row pointer moves — the commit pin (if any) is left untouched.
  db.prepare("UPDATE roles SET current_version_id = ? WHERE id = ?").run(created.id, role.id);

  return { role_id: role.id, version_id: created.id, version: nextVersion };
}
