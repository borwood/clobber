import type {
  Role,
  RoleDetailResponse,
  RoleListEntry,
} from "@clobber/shared";
import type { RoleVersionStore } from "../role-version-store.ts";

export interface RoleViewDeps {
  readonly roleVersions: RoleVersionStore;
}

export function buildListEntry(
  role: Role,
  deps: RoleViewDeps,
): RoleListEntry | null {
  if (role.current_version_id === undefined) return null;
  const version = deps.roleVersions.get(role.current_version_id);
  if (version === null) return null;
  return {
    id: role.id,
    name: role.name,
    persistent: role.persistent,
    current_version_id: role.current_version_id,
    version: version.version,
    created_at: role.created_at,
    ...(role.description === undefined ? {} : { description: role.description }),
    ...(role.allowed_tools === undefined
      ? {}
      : { allowed_tools: [...role.allowed_tools] }),
  };
}

export function buildDetail(
  role: Role,
  deps: RoleViewDeps,
): RoleDetailResponse | null {
  if (role.current_version_id === undefined) return null;
  const version = deps.roleVersions.get(role.current_version_id);
  if (version === null) return null;
  return {
    id: role.id,
    name: role.name,
    persistent: role.persistent,
    current_version: {
      id: version.id,
      version: version.version,
      framing: version.framing,
      system_prompt: version.system_prompt,
      skills: JSON.parse(version.skills_json),
      allowed_tools: JSON.parse(version.allowed_tools_json),
      hooks: JSON.parse(version.hooks_json),
      triggers: JSON.parse(version.triggers_json),
      seed_refs: JSON.parse(version.seed_refs_json),
      wake_programs: JSON.parse(version.wake_programs_json),
      created_at: version.created_at,
    },
    version_history: deps.roleVersions.listForRole(role.id),
    ...(role.description === undefined ? {} : { description: role.description }),
  };
}
