import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { baseRole, enumerateShippedRoles, type BaseLayer, type RoleBundleData } from "@clobber/runtime";
import {
  deserializeRoleTree,
  roleSnapshotToContract,
  serializeRoleTree,
  type RoleTree,
  type RoleTreeContract,
} from "./role-tree.ts";
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

// Materialize a fresh upstream repo at `dir` (which must be an empty directory).
// Commits the base layer on `base`, then forks one branch per shipped role and
// commits its effective (base ⊕ fork) tree. HEAD is left on `base`.
export function materializeUpstreamRoleRepo(dir: string): UpstreamRoleRepo {
  git(dir, "init", "-q", "-b", BASE_BRANCH);

  commitTree(dir, serializeRoleTree(baseContract(baseRole)), "base: universal layer");
  const baseSha = revParse(dir, BASE_BRANCH);

  const forks = new Map<string, ForkRef>();
  for (const loaded of enumerateShippedRoles()) {
    const name = loaded.manifest.name;
    const branch = `${name}-default`;
    git(dir, "checkout", "-q", "-b", branch, BASE_BRANCH);
    const snapshot = snapshotShippedBundle({ loaded, allowedTools: loaded.allowedTools });
    commitTree(dir, serializeRoleTree(roleSnapshotToContract(snapshot)), `${name}: fork from base`);
    forks.set(name, { branch, sha: revParse(dir, branch) });
  }

  git(dir, "checkout", "-q", BASE_BRANCH);
  return { dir, baseBranch: BASE_BRANCH, baseSha, forks };
}

// Embodiment-from-a-commit: read the tree at `ref` (a branch name or sha),
// deserialize it through the #348 codec, and project it into the runtime bundle
// the spawn path materializes.
export function loadRoleBundleAtCommit(
  dir: string,
  ref: string,
  identity: BundleIdentity,
): RoleBundleData {
  const contract = deserializeRoleTree(readTreeAtCommit(dir, ref));
  return bundleFromContract(contract, identity);
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
    seedRefs: contract.seedRefs,
    wakePrograms: contract.wakePrograms,
    ...(contract.defaultWakeProgram === null
      ? {}
      : { defaultWakeProgram: contract.defaultWakeProgram }),
    hooksJson: contract.hooks,
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
  };
}

// Replace the working tree with exactly `tree` and commit it. Clearing first
// makes the commit reflect the tree precisely regardless of what the parent
// branch left behind; git content-addresses blobs, so files whose bytes match
// the parent reuse its objects and the merge-base stays shared. `--allow-empty`
// keeps a fork that happens to equal base a legitimate (empty) commit.
function commitTree(dir: string, tree: RoleTree, message: string): void {
  clearWorkingTree(dir);
  for (const [rel, content] of tree) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.email=clobber@local",
    "-c",
    "user.name=clobber",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    message,
  );
}

function clearWorkingTree(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

// Reconstruct a role tree from the commit: list the blobs, then read each one
// verbatim. `git show <ref>:<path>` emits the blob exactly, so empty files and
// trailing newlines round-trip the codec losslessly.
function readTreeAtCommit(dir: string, ref: string): RoleTree {
  const listing = git(dir, "ls-tree", "-r", "--name-only", ref)
    .split("\n")
    .filter((line) => line.length > 0);
  const tree = new Map<string, string>();
  for (const path of listing) {
    tree.set(path, git(dir, "show", `${ref}:${path}`));
  }
  return tree;
}

function revParse(dir: string, ref: string): string {
  return git(dir, "rev-parse", ref).trim();
}

function git(dir: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}
