import type { Role, RoleEditManifest, RoleTrigger } from "@clobber/shared";
import { commitOnBranch, ensureEditBranch } from "./role-checkout-repo.ts";
import type { CommitProvenance } from "./role-git.ts";
import { loadRoleContractAtCommit } from "./role-repo.ts";
import { resolveCurrentRoleVersion } from "./resolve-role-content.ts";
import { roleSnapshotToContract } from "./role-tree-snapshot.ts";
import type { RoleTreeContract } from "./role-tree.ts";
import {
  ensureCommitPinned,
  manifestFromRole,
  readSidecar,
  repoDirOf,
  requireConfig,
  type RequiredConfig,
  type RoleCheckoutDeps,
  type RouteResult,
} from "./role-checkout-context.ts";

// #414 — the single role-mutation substrate: every role edit (interactive
// working-copy `commit` AND the one-shot patches: roles edit / self-skills /
// operator triggers) compiles to a commit on the role branch that ADVANCES THE
// PIN. The version-row write path (which minted a row and NULLed the pin,
// silently demoting a git-backed role — the #396 violation) is retired.

// Triggers are a persistent-role-only capability. The one-shot routes early-out
// on the pre-patch role before doing any git work; `finalizeRoleCommit` re-checks
// the post-patch contract at commit time (the working-copy `commit` verb has no
// separate early check). Both reject the same way — the rule lives here once.
export function triggersRequirePersistent(
  role: Role,
  triggers: readonly RoleTrigger[] | undefined,
): boolean {
  return triggers !== undefined && triggers.length > 0 && !role.persistent;
}

export interface FinalizeRoleCommitInput {
  readonly role: Role;
  readonly repoDir: string;
  readonly branch: string;
  // The branch tip the edit is based on; the trigger-change check compares the
  // committed triggers against this base so a non-trigger edit never churns the
  // dispatch table.
  readonly baseSha: string;
  readonly contract: RoleTreeContract;
  readonly manifest: RoleEditManifest;
  readonly message: string;
  // #637 — present on working-copy commits only; one-shot patches leave it absent.
  readonly provenance?: CommitProvenance;
}

// The shared tail lifted from `commitCheckout`: serialize the in-memory contract
// → commit on the branch → re-pin → re-sync the manifest columns → warm the
// content cache → reload the scheduler iff a persistent role's triggers changed.
// Both the working-copy `commit` verb and the one-shot patches call this, so the
// no-demotion guarantee lives in exactly one place.
export function finalizeRoleCommit(
  deps: RoleCheckoutDeps,
  cfg: RequiredConfig,
  input: FinalizeRoleCommitInput,
): RouteResult {
  if (input.contract.triggers.length > 0 && !input.manifest.persistent) {
    return { status: 422, body: { error: "triggers are only allowed on persistent roles" } };
  }

  const baseTriggers = JSON.stringify(
    loadRoleContractAtCommit(input.repoDir, input.baseSha).triggers,
  );
  const newRef = commitOnBranch(
    input.repoDir,
    input.branch,
    input.contract,
    input.message,
    input.provenance,
  );

  // Re-sync the pin + index/cache immediately after the commit returns the sha,
  // so a failure after this point leaves a coherent row. pinCommit is idempotent.
  deps.roles.pinCommit(input.role.id, newRef);
  deps.roles.syncManifestColumns(input.role.id, {
    description: input.manifest.description,
    persistent: input.manifest.persistent,
    ...(input.manifest.effort === undefined ? {} : { effort: input.manifest.effort }),
    ...(input.manifest.model === undefined ? {} : { model: input.manifest.model }),
  });
  cfg.roleContentCache.getOrLoad(newRef.sha, input.repoDir);
  if (input.manifest.persistent && JSON.stringify(input.contract.triggers) !== baseTriggers) {
    deps.scheduler.reloadRole(input.role.id);
  }

  return {
    status: 200,
    body: {
      role_id: input.role.id,
      branch: newRef.branch,
      sha: newRef.sha,
      description: input.manifest.description,
      persistent: input.manifest.persistent,
      ...(input.manifest.effort === undefined ? {} : { effort: input.manifest.effort }),
      ...(input.manifest.model === undefined ? {} : { model: input.manifest.model }),
      no_new_version: true,
    },
  };
}

export interface PatchThroughPinInput {
  readonly role: Role;
  readonly workspaceId: string;
  // Present for agent-scoped routes: the calling session's desk. A one-shot edit
  // is refused while that desk holds an open checkout for the same role, so it
  // can't silently clobber a working copy the agent is mid-edit on.
  readonly deskDir?: string;
  readonly apply: (current: RoleTreeContract) => RoleTreeContract;
  // Manifest fields the patch overrides (e.g. a `roles edit --description`); the
  // rest are carried from the role row.
  readonly description?: string;
  readonly message: string;
}

// The one-shot front-door: pin the role (lazy per-role cutover if still
// row-backed), read its current content as a contract from the pinned tree,
// apply the in-memory patch, and finalize the commit. No faked checkout — the
// contract goes straight to `commitOnBranch`.
export function patchRoleThroughPin(
  deps: RoleCheckoutDeps,
  input: PatchThroughPinInput,
): RouteResult {
  const cfg = requireConfig(deps);
  const role = ensureCommitPinned(deps, cfg, input.role, input.workspaceId);
  const commit = role.current_commit;
  if (commit === undefined) {
    throw new Error(`role ${role.name} resolved without a commit pin after ensureCommitPinned`);
  }

  if (input.deskDir !== undefined) {
    const open = readSidecar(input.deskDir);
    if (open !== null && open.role_id === role.id) {
      return {
        status: 409,
        body: {
          error: `a checkout is open for role ${role.name}; commit or discard it before a one-shot edit`,
        },
      };
    }
  }

  const repoDir = repoDirOf(deps, role);
  const branch = role.name;
  ensureEditBranch(repoDir, branch, commit.sha);

  const view = resolveCurrentRoleVersion(role, deps);
  if (view === null) {
    throw new Error(`commit-pinned role ${role.name} resolved no content view`);
  }
  const patched = input.apply(roleSnapshotToContract(view));

  const manifest: RoleEditManifest = {
    ...manifestFromRole(role),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
  return finalizeRoleCommit(deps, cfg, {
    role,
    repoDir,
    branch,
    baseSha: commit.sha,
    contract: patched,
    manifest,
    message: input.message,
  });
}
