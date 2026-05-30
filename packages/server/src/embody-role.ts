import type { RoleBundleData } from "@clobber/runtime";
import type { Role, Session } from "@clobber/shared";
import { bundleFromContract } from "./role-repo.ts";
import type { RoleContentCache } from "./role-content-cache.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import { resolveRoleRepoDir, type RoleRepoResolution } from "./resolve-role-repo-dir.ts";

// #349 git-as-truth — the embodiment dispatch. A role/session is pinned EITHER by
// a `role_versions` row (the pre-#349 store) OR by a commit into the upstream role
// repo. This is the single chokepoint that turns a pin into the runtime bundle,
// so every embodiment site (spawn, resume, whiteboard) reads content the same way
// and the two pin kinds coexist with no data migration.

export type RolePin =
  | { readonly kind: "version"; readonly versionId: string }
  | { readonly kind: "commit"; readonly branch: string; readonly sha: string };

export interface RoleEmbodimentDeps extends RoleRepoResolution {
  readonly roleVersions: RoleVersionStore;
  // Present only when git-as-truth is configured (a role repo was materialized at
  // boot). A commit pin without these is a misconfiguration, not a fallback case —
  // embodyRole throws rather than silently degrade.
  readonly roleContentCache?: RoleContentCache;
}

// The role's live pin — prefers the commit ref (git-backed) over the row pointer.
export function rolePin(role: Role): RolePin | null {
  if (role.current_commit !== undefined) {
    return { kind: "commit", branch: role.current_commit.branch, sha: role.current_commit.sha };
  }
  if (role.current_version_id !== undefined) {
    return { kind: "version", versionId: role.current_version_id };
  }
  return null;
}

// Resume's pin: the content the session was embodied with, so it re-resolves the
// SAME commit even after the role's current pointer advances. Falls back to the
// role's current pin only for sessions that predate pin-capture.
export function sessionPin(session: Session, role: Role): RolePin | null {
  if (session.role_commit !== undefined) {
    return { kind: "commit", branch: session.role_commit.branch, sha: session.role_commit.sha };
  }
  if (session.role_version_id !== undefined) {
    return { kind: "version", versionId: session.role_version_id };
  }
  return rolePin(role);
}

export function embodyRole(
  role: Role,
  pin: RolePin | null,
  deps: RoleEmbodimentDeps,
): RoleBundleData | null {
  if (pin === null) return null;
  if (pin.kind === "version") return deps.roleVersions.loadAsBundle(pin.versionId);
  const repoDir = resolveRoleRepoDir(role, deps);
  if (deps.roleContentCache === undefined || repoDir === undefined) {
    throw new Error(
      "commit-pinned role embodied without an upstream role repo configured",
    );
  }
  const { contract } = deps.roleContentCache.getOrLoad(pin.sha, repoDir);
  return bundleFromContract(contract, {
    pluginName: role.name,
    ...(role.description === undefined ? {} : { description: role.description }),
  });
}
