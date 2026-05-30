import { randomUUID } from "node:crypto";
import { RoleVersionSchema, type Role, type RoleVersion } from "@clobber/shared";
import { roleContractToSnapshot } from "./role-tree.ts";
import type { RoleContentCache } from "./role-content-cache.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import { resolveRoleRepoDir, type RoleRepoResolution } from "./resolve-role-repo-dir.ts";

// #361 git-as-truth — the read-view that unifies the two pin kinds. Pre-#349
// every site read a role's content as `roleVersions.get(role.current_version_id)`;
// a git-backed role has no row, so each of those sites would 500. This is the one
// chokepoint they go through instead: it returns the role's current content as a
// `RoleVersion` VIEW regardless of how the role is pinned.
//
//  - row-backed   → the persisted `role_versions` row, verbatim.
//  - commit-backed → the tree at the pinned sha, read through the materialized
//    cache and projected into the row shape via the #348 codec. This is a pure
//    READ: nothing is persisted and the role is NOT demoted. Write verbs that
//    want to mutate a git-backed role read the view here, then write a real row
//    and demote separately.
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
  if (role.current_version_id !== undefined) {
    return deps.roleVersions.get(role.current_version_id);
  }
  return null;
}
