import { randomUUID } from "node:crypto";
import { RoleVersionSchema, type Role, type RoleVersion } from "@clobber/shared";
import { roleContractToSnapshot } from "./role-tree-snapshot.ts";
import type { RoleContentCache } from "./role-content-cache.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import { resolveRoleRepoDir, type RoleRepoResolution } from "./resolve-role-repo-dir.ts";

// #361 / #491 git-as-truth — the read-view for commit-pinned roles. Returns the
// role's current content as a synthetic `RoleVersion` VIEW, reading from the git
// tree at the pinned sha through the materialized cache and projecting into the
// row shape via the #348 codec. A pure READ — nothing is persisted.
//
// The view's `id` is synthetic (the content lives in git, not a row) — load-
// bearing readers (the command gate, the trigger scheduler, the write verbs)
// consume content fields, never the id.
export interface RoleContentResolverDeps extends RoleRepoResolution {
  readonly roleVersions: RoleVersionStore;
  // Present only when git-as-truth is configured (a role repo was materialized at
  // boot). A commit pin without these is a misconfiguration, not a fallback —
  // resolving throws rather than silently degrade (mirrors embodyRole).
  readonly roleContentCache?: RoleContentCache;
}

export function resolveCurrentRoleVersion(
  role: Role,
  deps: RoleContentResolverDeps,
): RoleVersion | null {
  if (role.current_commit !== undefined) {
    const repoDir = resolveRoleRepoDir(role, deps);
    if (deps.roleContentCache === undefined || repoDir === undefined) {
      throw new Error(
        "commit-pinned role resolved without an upstream role repo configured",
      );
    }
    const { contract, contractVersion } = deps.roleContentCache.getOrLoad(
      role.current_commit.sha,
      repoDir,
    );
    return RoleVersionSchema.parse({
      id: randomUUID(),
      role_id: role.id,
      version: 1,
      ...roleContractToSnapshot(contract),
      contract_version: contractVersion,
      created_at: 0,
    });
  }
  // No commit pin — read the latest version row for this role. In production all
  // roles are commit-pinned (#491), so this path is only reached in tests that
  // configure role content via role_versions rows directly.
  return deps.roleVersions.latestForRole(role.id);
}
