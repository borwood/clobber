import type { Role } from "@clobber/shared";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import {
  BASE_BRANCH,
  commitContractOnBranch,
  type ForkRef,
  type UpstreamRoleRepo,
} from "./role-repo.ts";
import { roleSnapshotToContract } from "./role-tree-snapshot.ts";
import type { WorkspaceRoleRepos } from "./workspace-role-repos.ts";

// The per-role cutover's inputs, narrowed so the working-copy `checkout` verb
// (#216) can reuse it for the lazy on-demand cutover without owning the whole
// boot migration's deps. `forks` is the upstream fork-tip map (= upstream.forks).
export interface WorkspaceRoleCutoverDeps {
  readonly roles: Pick<RoleStore, "pinCommit">;
  readonly roleVersions: Pick<RoleVersionStore, "get">;
  readonly workspaceRepos: WorkspaceRoleRepos;
  readonly forks: ReadonlyMap<string, ForkRef>;
}

// #351 — forward-only migration of existing role state into topology-B fork
// repos. Three role shapes, each non-destructive (`role_versions` rows are
// always retained — they are the path back AND the rows sessions resume off):
//
//  - row-backed workspace role → serialize its current version, commit it as a
//    NEW commit on a `<name>` branch in the workspace's clone (parented off the
//    upstream `<name>-default` fork when one exists, else `base`, so a merge-base
//    ancestor exists for the #265 upgrade), and repoint the DB pin to that sha.
//  - row-backed NULL-workspace (global template) role → pin to the upstream
//    `<name>-default` fork tip: the shipped default IS its canonical ancestor
//    (decision 2026-05-30), so no new commit is minted.
//  - already commit-pinned role (post-#385 seeding) → its sha lives in the shared
//    upstream; ensure the workspace's clone exists so the pin resolves locally.
//    The pin (branch+sha) is unchanged because a clone preserves object SHAs.

export interface RoleStateMigrationDeps {
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly upstream: UpstreamRoleRepo;
  readonly workspaceRepos: WorkspaceRoleRepos;
}

export interface RoleStateMigrationResult {
  readonly migrated: number;
  readonly pinnedToDefault: number;
  readonly clonesEnsured: number;
  readonly skipped: number;
}

export function migrateRoleStateToWorkspaceRepos(
  deps: RoleStateMigrationDeps,
): RoleStateMigrationResult {
  let migrated = 0;
  let pinnedToDefault = 0;
  let clonesEnsured = 0;
  let skipped = 0;

  for (const role of deps.roles.list()) {
    if (role.current_commit !== undefined) {
      if (role.workspace_id !== undefined) deps.workspaceRepos.dirFor(role.workspace_id);
      clonesEnsured += 1;
      continue;
    }
    // After #491: no current_version_id to read content from. Try pinning
    // null-workspace roles to their upstream default fork; workspace roles are skipped.
    if (role.workspace_id === undefined) {
      if (pinNullWorkspaceToDefault(role, deps)) pinnedToDefault += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }

  return { migrated, pinnedToDefault, clonesEnsured, skipped };
}

// A global template role becomes the fork ancestor: pin it to the existing
// upstream `<name>-default` tip. Returns false when no shipped default matches
// (nothing to anchor to — left untouched for inspection rather than guessed).
function pinNullWorkspaceToDefault(role: Role, deps: RoleStateMigrationDeps): boolean {
  const fork = deps.upstream.forks.get(role.name);
  if (fork === undefined) return false;
  deps.roles.pinCommit(role.id, { branch: fork.branch, sha: fork.sha });
  return true;
}

// #491 — row-backed roles are obsolete. This function is kept for compilation
// compatibility only; it is unreachable in production (all roles are commit-pinned
// before `migrateRoleStateToWorkspaceRepos` even runs).
export function migrateWorkspaceRole(
  _role: Role,
  _workspaceId: string,
  _deps: WorkspaceRoleCutoverDeps,
): void {
  throw new Error("migrateWorkspaceRole: row-backed migration is obsolete after #491");
}
