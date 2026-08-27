import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { baseRole, enumerateShippedRoles, type BaseLayer, type RoleBundleData } from "@clobber/runtime";
import { deserializeRoleTree, serializeRoleTree, type RoleTreeContract } from "./role-tree.ts";
import { roleSnapshotToContract } from "./role-tree-snapshot.ts";
import { commitTree, git, readTreeAtCommit, revParse, writeTreeObject } from "./role-git.ts";
import { snapshotShippedBundle } from "./role-version-snapshot.ts";

// #349 — the upstream role git repo: the canonical store of role versions and
// lineage. The engine MATERIALIZES it from the shipped bundles via the #348
// codec — `base` is the merge-base every fork descends from, each shipped role
// is a `<name>-default` branch off it, and a role's content is read back by
// deserializing the tree at a commit. A role update = a new engine version
// advancing these branches; a workspace `git merge`s upstream to adopt, and the
// #348 decomposition is what keeps that merge clean.
//
// This module owns only the repo mechanics. Wiring it into embodiment (the DB
// pointer+cache, spawn pinning a sha, the #237/#239 contract rewire) is the
// stacked follow-up; the data migration of existing `role_versions` rows is #351.

export const BASE_BRANCH = "base";

export interface ForkRef {
  readonly branch: string;
  readonly sha: string;
}

export interface UpstreamRoleRepo {
  readonly dir: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  // role name → its fork branch and pinned tip sha.
  readonly forks: ReadonlyMap<string, ForkRef>;
}

// The tree carries no identity (the role name and description are properties of
// the role record, not the commit), so embodiment supplies them when projecting
// a tree's contract back into a runtime bundle.
export interface BundleIdentity {
  readonly pluginName: string;
  readonly description?: string;
}

// Materialize a fresh upstream repo at `dir`, creating it if it does not exist.
// Commits the base layer on `base`, then forks one branch per shipped role and
// commits its effective (base ⊕ fork) tree. HEAD is left on `base`.
export function materializeUpstreamRoleRepo(dir: string): UpstreamRoleRepo {
  // On a fresh boot `dir` (`<dataDir>/clobber-role-repo`) has never been
  // created, and `git -C <dir> init` needs it to already exist. Create it
  // first — `recursive: true` is idempotent if it's already an empty dir.
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", BASE_BRANCH);

  commitTree(dir, serializeRoleTree(baseContract(baseRole)), "base: universal layer");
  const baseSha = revParse(dir, BASE_BRANCH);

  const forks = new Map<string, ForkRef>();
  for (const loaded of enumerateShippedRoles()) {
    const name = loaded.manifest.name;
    const snapshot = snapshotShippedBundle({ loaded, allowedTools: loaded.allowedTools });
    // Phase 0: roleSnapshotToContract returns habits: [] because the version-store
    // has no habit column. Overlay the shipped bundle's habits so the git tree
    // includes them from the start; workspace forks inherit them on first merge.
    const contract = { ...roleSnapshotToContract(snapshot), habits: loaded.habits };
    forks.set(
      name,
      commitContractOnBranch(
        dir,
        `${name}-default`,
        BASE_BRANCH,
        contract,
        `${name}: fork from base`,
      ),
    );
  }

  git(dir, "checkout", "-q", BASE_BRANCH);
  return { dir, baseBranch: BASE_BRANCH, baseSha, forks };
}

// `base` and the engine's `<name>-default` branches are the clone's
// upstream-tracking refs — shared lineage, not any one role's own fork. A role
// still pinned to a `-default` branch (a seeded, never-edited role) thus has no
// fork-branch residue to clean; only a role on its own `<name>` branch (a fork,
// or a role edited through the working-copy flow) does.
export function isProtectedRoleBranch(branch: string): boolean {
  return branch === BASE_BRANCH || branch.endsWith("-default");
}

// Remove a fork's branch from a (workspace) role repo — the inverse of
// commitContractOnBranch, used by `roles delete`. HEAD may sit on the branch
// (a fork leaves it checked out), so we move to `base` before deleting. Callers
// gate on isProtectedRoleBranch; the throw here is a defense-in-depth invariant.
export function deleteForkBranch(dir: string, branch: string): void {
  if (isProtectedRoleBranch(branch)) {
    throw new Error(`refusing to delete protected role branch: ${branch}`);
  }
  git(dir, "checkout", "-q", BASE_BRANCH);
  git(dir, "branch", "-D", branch);
}

// Branch `branch` off `fromRef`, commit `contract`'s serialized tree, and return
// the resulting pin. The fork-materialization loop builds each shipped role's
// default branch this way; it is also the seam a caller (or test) uses to commit
// a bespoke contract — e.g. a role tree carrying triggers — onto its own branch.
export function commitContractOnBranch(
  dir: string,
  branch: string,
  fromRef: string,
  contract: RoleTreeContract,
  message: string,
): ForkRef {
  git(dir, "checkout", "-q", "-b", branch, fromRef);
  commitTree(dir, serializeRoleTree(contract), message);
  return { branch, sha: revParse(dir, branch) };
}

// Advance `branch` (which must already exist) to a new commit carrying
// `contract`'s tree — but only when that tree actually differs from the
// branch's current tip. Advancing (a new commit on the existing branch, not a
// recreated one) preserves lineage: the old tip stays an ancestor, so a
// workspace's later `git merge upstream/<branch>` stays clean. The no-op path
// (tree unchanged) is what keeps re-derivation idempotent across boots — #532
// bars empty/no-op commits.
export function advanceContractOnBranch(
  dir: string,
  branch: string,
  contract: RoleTreeContract,
  message: string,
): ForkRef {
  git(dir, "checkout", "-q", branch);
  const priorTreeSha = revParse(dir, `${branch}^{tree}`);
  const newTreeSha = writeTreeObject(dir, serializeRoleTree(contract));
  if (newTreeSha !== priorTreeSha) {
    git(
      dir,
      "-c",
      "user.email=clobber@local",
      "-c",
      "user.name=clobber",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    );
  }
  return { branch, sha: revParse(dir, branch) };
}

// Idempotent boot entrypoint: materialize the upstream repo into `dir` the
// first time. On subsequent boots, re-derive each shipped role's `-default`
// branch from the CURRENT shipped bundle and advance it if content drifted
// since the last boot (#532 — a long-lived install must not stay pinned to
// whatever the repo looked like the day it was first materialized). This is
// the read-only baseline only: fork branches (a role edited through the
// working-copy flow, or workspace-invented) are never touched here, and pins
// don't auto-follow a branch tip — a workspace adopts new content explicitly.
export function ensureUpstreamRoleRepo(dir: string): UpstreamRoleRepo {
  if (!existsSync(join(dir, ".git"))) {
    return materializeUpstreamRoleRepo(dir);
  }
  const forks = new Map<string, ForkRef>();
  for (const loaded of enumerateShippedRoles()) {
    const name = loaded.manifest.name;
    const branch = `${name}-default`;
    const snapshot = snapshotShippedBundle({ loaded, allowedTools: loaded.allowedTools });
    const contract = { ...roleSnapshotToContract(snapshot), habits: loaded.habits };
    forks.set(
      name,
      advanceContractOnBranch(dir, branch, contract, `${name}: re-derive from shipped bundle`),
    );
  }
  git(dir, "checkout", "-q", BASE_BRANCH);
  return { dir, baseBranch: BASE_BRANCH, baseSha: revParse(dir, BASE_BRANCH), forks };
}

// Embodiment-from-a-commit: read the tree at `ref` (a branch name or sha),
// deserialize it through the #348 codec, and project it into the runtime bundle
// the spawn path materializes.
export function loadRoleBundleAtCommit(
  dir: string,
  ref: string,
  identity: BundleIdentity,
): RoleBundleData {
  return bundleFromContract(loadRoleContractAtCommit(dir, ref), identity);
}

// The identity-free half of embodiment-from-a-commit: the tree's contract, which
// the sha-keyed content cache stores (identity is per-role, supplied when the
// cached contract is projected into a bundle).
export function loadRoleContractAtCommit(dir: string, ref: string): RoleTreeContract {
  return deserializeRoleTree(readTreeAtCommit(dir, ref));
}

// Project a tree contract into the runtime bundle. The codec's contract is a
// superset of the bundle (it also carries triggers + cli commands, which the
// runtime plugin layout does not consume); this drops those, mirroring what the
// DB-row `loadAsBundle` projects today.
export function bundleFromContract(
  contract: RoleTreeContract,
  identity: BundleIdentity,
): RoleBundleData {
  return {
    pluginName: identity.pluginName,
    ...(identity.description === undefined ? {} : { description: identity.description }),
    framing: contract.framing,
    systemPrompt: contract.systemPrompt,
    allowedTools: contract.allowedTools,
    skills: contract.skills,
    promptModuleRefs: contract.seedRefs,
    wakePrograms: contract.wakePrograms,
    ...(contract.defaultWakeProgram === null
      ? {}
      : { defaultWakeProgram: contract.defaultWakeProgram }),
    hooksJson: contract.hooks,
    habits: contract.habits,
  };
}

// base is abstract — it carries no identity (empty framing / prompt) and no
// role-specific sets. It owns the universal layer the codec can represent:
// hooks, the baseline tool set, and (transitively) its skills. Forks inherit
// these byte-identically, so a later base change merges down through the shared
// merge-base blobs.
function baseContract(base: BaseLayer): RoleTreeContract {
  return {
    framing: "",
    systemPrompt: "",
    skills: base.skills,
    allowedTools: base.allowedTools,
    allowedCliCommands: [],
    hooks: base.hooksJson,
    triggers: [],
    seedRefs: [],
    wakePrograms: [],
    defaultWakeProgram: null,
    habits: [],
  };
}

