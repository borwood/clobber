import type { RoleBundleData } from "@clobber/runtime";
import type { Role, Session } from "@clobber/shared";
import { bundleFromContract } from "./role-repo.ts";
import type { RoleContentCache } from "./role-content-cache.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import { resolveRoleRepoDir, type RoleRepoResolution } from "./resolve-role-repo-dir.ts";

// #349 git-as-truth — the embodiment dispatch. A role/session is pinned by a
// commit into the upstream role repo. This is the single chokepoint that turns
// a commit pin into the runtime bundle, so every embodiment site (spawn, resume,
// whiteboard) reads content the same way.

export type RolePin = { readonly kind: "commit"; readonly branch: string; readonly sha: string };

export interface RoleEmbodimentDeps extends RoleRepoResolution {
  readonly roleVersions: RoleVersionStore;
  // Present only when git-as-truth is configured (a role repo was materialized at
  // boot). A commit pin without these is a misconfiguration, not a fallback case —
  // embodyRole throws rather than silently degrade.
  readonly roleContentCache?: RoleContentCache;
}

// The role's live pin — returns the commit ref or null if the role has no pin.
export function rolePin(role: Role): RolePin | null {
  if (role.current_commit !== undefined) {
    return { kind: "commit", branch: role.current_commit.branch, sha: role.current_commit.sha };
  }
  return null;
}

// Resume's pin: the content the session was embodied with, so it re-resolves the
// SAME commit even after the role's current pointer advances.
export function sessionPin(session: Session, role: Role): RolePin | null {
  if (session.role_commit !== undefined) {
    return { kind: "commit", branch: session.role_commit.branch, sha: session.role_commit.sha };
  }
  return rolePin(role);
}

export function embodyRole(
  role: Role,
  pin: RolePin | null,
  deps: RoleEmbodimentDeps,
): RoleBundleData | null {
  if (pin !== null) {
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
  // No commit pin — fall back to the latest version row. In production all roles
  // are commit-pinned (#491), so this path is only reached in tests that create
  // roles without a git-backed role repo.
  const latest = deps.roleVersions.latestForRole(role.id);
  if (latest === null) return null;
  return deps.roleVersions.loadAsBundle(latest.id);
}
