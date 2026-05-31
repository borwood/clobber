import type { Role } from "@clobber/shared";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import {
  BASE_BRANCH,
  commitContractOnBranch,
  type ForkRef,
  type UpstreamRoleRepo,
} from "./role-repo.ts";
import { roleSnapshotToContract } from "./role-tree.ts";
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
    if (role.current_version_id === undefined) {
      skipped += 1;
      continue;
    }
    if (role.workspace_id === undefined) {
      if (pinNullWorkspaceToDefault(role, deps)) pinnedToDefault += 1;
      else skipped += 1;
      continue;
    }
    migrateWorkspaceRole(role, role.workspace_id, {
      roles: deps.roles,
      roleVersions: deps.roleVersions,
      workspaceRepos: deps.workspaceRepos,
      forks: deps.upstream.forks,
    });
    migrated += 1;
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

// Commit a row-backed workspace role's current version onto a flat `<name>`
// branch (parented off the upstream `<name>-default` fork when one exists, so a
// merge-base ancestor exists for #265), then repoint the DB pin to that sha. The
// boot migration runs it across all roles; the #216 `checkout` verb runs it
// lazily for one role on first edit, so the working-copy flow works whether or
// not the global cutover (#395) has run.
export function migrateWorkspaceRole(
  role: Role,
  workspaceId: string,
  deps: WorkspaceRoleCutoverDeps,
): void {
  const version = deps.roleVersions.get(role.current_version_id!);
  if (version === null) throw new Error(`role ${role.id} pins a missing version row`);
  const contract = roleSnapshotToContract(version);

  const dir = deps.workspaceRepos.dirFor(workspaceId);
  const hasDefault = deps.forks.has(role.name);
  // In the clone the upstream fork is the remote-tracking ref `upstream/<name>`;
  // `base` is a local branch (the clone's default checkout).
  const parentRef = hasDefault ? `upstream/${role.name}-default` : BASE_BRANCH;
  const pin = commitContractOnBranch(
    dir,
    role.name,
    parentRef,
    contract,
    `migrate ${role.name} (role ${role.id})`,
  );
  deps.roles.pinCommit(role.id, pin);
}
