import type {
  Role,
  RoleDetailResponse,
  RoleListEntry,
} from "@clobber/shared";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
import { resolveCurrentRoleVersion } from "../resolve-role-content.ts";

// #385 — the views resolve through the commit-pin read-view, so a git-backed
// role is surfaced (not dropped) and carries its real commit ref as provenance
// instead of a synthesized version-row uuid. The deps mirror the resolver: the
// cache + repo dir are present iff git-as-truth is configured.
export interface RoleViewDeps {
  readonly roleVersions: RoleVersionStore;
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
}

export function buildListEntry(
  role: Role,
  deps: RoleViewDeps,
): RoleListEntry | null {
  const version = resolveCurrentRoleVersion(role, deps);
  if (version === null) return null;
  return {
    id: role.id,
    name: role.name,
    persistent: role.persistent,
    version: version.version,
    created_at: role.created_at,
    ...(role.current_version_id === undefined
      ? {}
      : { current_version_id: role.current_version_id }),
    ...(role.current_commit === undefined ? {} : { current_commit: role.current_commit }),
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
  const version = resolveCurrentRoleVersion(role, deps);
  if (version === null) return null;
  return {
    id: role.id,
    name: role.name,
    persistent: role.persistent,
    current_version: {
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
      // Surface the row id only for a row-backed role; a commit-pinned role's
      // view id is synthetic, so it carries the commit ref instead.
      ...(role.current_version_id === undefined ? {} : { id: version.id }),
      ...(role.current_commit === undefined ? {} : { current_commit: role.current_commit }),
    },
    version_history: deps.roleVersions.listForRole(role.id),
    ...(role.description === undefined ? {} : { description: role.description }),
  };
}
