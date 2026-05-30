import type { Role } from "@clobber/shared";
import type { WorkspaceRoleRepos } from "./workspace-role-repos.ts";

// #351 topology B — which on-disk repo resolves a role's commit pin. A migrated
// workspace role's sha lives ONLY in that workspace's clone, so it must resolve
// there; a null-workspace (global) role and any not-yet-migrated pin resolve from
// the shared upstream (`roleRepoDir`). When no `workspaceRepos` is configured the
// behaviour collapses to the pre-topology-B singular dir — zero regression.
export interface RoleRepoResolution {
  readonly roleRepoDir?: string;
  readonly workspaceRepos?: WorkspaceRoleRepos;
}

export function resolveRoleRepoDir(
  role: Role,
  deps: RoleRepoResolution,
): string | undefined {
  if (deps.roleRepoDir === undefined) return undefined;
  if (role.workspace_id !== undefined && deps.workspaceRepos !== undefined) {
    return deps.workspaceRepos.dirFor(role.workspace_id);
  }
  return deps.roleRepoDir;
}
