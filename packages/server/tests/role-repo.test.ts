import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRoleBundle } from "@clobber/runtime";
import type { RoleBundleData } from "@clobber/runtime";
import { roleSnapshotToContract } from "../src/role-tree-snapshot.ts";
import { snapshotShippedBundle } from "../src/role-version-snapshot.ts";
import {
  materializeUpstreamRoleRepo,
  ensureUpstreamRoleRepo,
  loadRoleBundleAtCommit,
  bundleFromContract,
  BASE_BRANCH,
} from "../src/role-repo.ts";

// #349 git-as-truth — the upstream role git repo is the canonical store. The
// engine MATERIALIZES it from the shipped bundles via the #348 codec: `base` is
// the merge-base, each shipped role is a fork branch off it, and embodiment
// reads a role's content back from the tree at a commit. This is a full-flow
// integration test against REAL git — the in-memory three-way merge in
// `role-tree-roundtrip.test.ts` only simulated what this proves for real.

function git(dir: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString();
}

// The bundle the live embodiment path would produce for a shipped role, before
// any git is involved — the oracle we hold the git round-trip against.
// Phase 0: roleSnapshotToContract returns habits: [] (no snapshot column), so
// we overlay loaded.habits to match what materializeUpstreamRoleRepo commits.
function inMemoryBundle(name: string): RoleBundleData {
  const loaded = loadRoleBundle(name);
  if (loaded === null) throw new Error(`no shipped role ${name}`);
  const snapshot = snapshotShippedBundle({ loaded, allowedTools: loaded.allowedTools });
  const contract = { ...roleSnapshotToContract(snapshot), habits: loaded.habits };
  return bundleFromContract(contract, {
    pluginName: name,
    description: loaded.manifest.description,
  });
}

describe("upstream role git repo (#349)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clobber-role-repo-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes a base branch + a fork branch per shipped role, base an ancestor of each fork", () => {
    const repo = materializeUpstreamRoleRepo(dir);

    expect(repo.baseBranch).toBe(BASE_BRANCH);
    // both shipped roles have a fork branch
    expect(repo.forks.has("manager")).toBe(true);
    expect(repo.forks.has("worker")).toBe(true);

    for (const [name, fork] of repo.forks) {
      expect(fork.branch).toBe(`${name}-default`);
      // the pinned sha resolves to the fork branch tip
      expect(git(dir, "rev-parse", fork.branch).trim()).toBe(fork.sha);
      // base is the genuine merge-base ancestor (the lineage the spike validated)
      const res = Bun.spawnSync(
        ["git", "-C", dir, "merge-base", "--is-ancestor", BASE_BRANCH, fork.branch],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(res.exitCode, `${BASE_BRANCH} is ancestor of ${fork.branch}`).toBe(0);
    }
  });

  it("materializes on a fresh boot where the role-repo dir does not exist yet (#365)", () => {
    // The live boot path derives `<dataDir>/clobber-role-repo` and hands it to
    // ensureUpstreamRoleRepo before anything has created it. `git -C <dir> init`
    // needs the dir to already exist, so a clean install used to fail here.
    const fresh = join(dir, "clobber-role-repo");
    const repo = ensureUpstreamRoleRepo(fresh);

    expect(repo.baseBranch).toBe(BASE_BRANCH);
    expect(repo.forks.has("manager")).toBe(true);
    expect(repo.forks.has("worker")).toBe(true);
    for (const [name, fork] of repo.forks) {
      expect(fork.branch).toBe(`${name}-default`);
      expect(git(fresh, "rev-parse", fork.branch).trim()).toBe(fork.sha);
    }
  });

  it("reads a role bundle back at the pinned commit, byte-equal to the in-memory embodiment path", () => {
    const repo = materializeUpstreamRoleRepo(dir);

    for (const name of ["manager", "worker"]) {
      const fork = repo.forks.get(name)!;
      const loaded = loadRoleBundle(name)!;
      const fromGit = loadRoleBundleAtCommit(dir, fork.sha, {
        pluginName: name,
        description: loaded.manifest.description,
      });
      expect(fromGit, `embodiment-from-commit for ${name}`).toEqual(inMemoryBundle(name));
    }
  });

  it("adopts an upstream base change into a fork via a clean git merge (no conflict)", () => {
    const repo = materializeUpstreamRoleRepo(dir);
    const worker = repo.forks.get("worker")!;

    // Engine advances `base` with a new universal skill every fork should
    // inherit. A skill is a fresh directory the fork has never touched, so the
    // merge is a disjoint add — the decomposition rule #348 banked on.
    git(dir, "checkout", "-q", BASE_BRANCH);
    const skillDir = join(dir, "skills", "safety");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: safety\ndescription: u\n---\nbody\n");
    git(dir, "add", "-A");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base: universal skill");

    // The fork fetch+merges to adopt — clean, because the new skill path is
    // disjoint from everything the fork owns.
    git(dir, "checkout", "-q", worker.branch);
    const merge = Bun.spawnSync(
      ["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-edit", BASE_BRANCH],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(merge.exitCode, `merge stderr: ${merge.stderr.toString()}`).toBe(0);

    // The fork keeps its own identity AND gains the universal skill.
    const sha = git(dir, "rev-parse", worker.branch).trim();
    const merged = loadRoleBundleAtCommit(dir, sha, { pluginName: "worker" });
    expect(merged.systemPrompt).toBe(inMemoryBundle("worker").systemPrompt);
    expect(merged.skills.map((s) => s.name)).toContain("safety");
  });
});

// #532 — boot must idempotently re-derive each `-default` branch from the
// CURRENT shipped bundle, so a long-lived install's baseline never stays
// frozen at whatever it looked like the day it was first materialized. These
// tests build their own old-state fixture (rolling `manager-default` back to a
// stripped contract) rather than relying on any live install's tips.
describe("baseline re-derivation on boot (#532)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clobber-role-repo-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Roll `manager-default` back to a contract stripped of content the CURRENT
  // shipped bundle carries (bootstrap-interview skill + workspace-open
  // trigger), simulating an install whose baseline predates a later engine
  // release — programmatically, not by reading real install state.
  function rollBackManagerDefault(): string {
    git(dir, "checkout", "-q", "manager-default");
    rmSync(join(dir, "skills", "bootstrap-interview"), { recursive: true, force: true });
    rmSync(join(dir, "triggers", "workspace-open.json"), { force: true });
    git(dir, "add", "-A");
    git(
      dir,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "manager: simulated stale baseline (pre-#689)",
    );
    return git(dir, "rev-parse", "manager-default").trim();
  }

  it("advances a stale -default tip to the current shipped bundle, preserving lineage", () => {
    materializeUpstreamRoleRepo(dir);
    const rolledBackTip = rollBackManagerDefault();

    const repo = ensureUpstreamRoleRepo(dir);
    const advancedTip = repo.forks.get("manager")!.sha;

    expect(advancedTip).not.toBe(rolledBackTip);
    const isAncestor = Bun.spawnSync(
      ["git", "-C", dir, "merge-base", "--is-ancestor", rolledBackTip, advancedTip],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(isAncestor.exitCode, "rolled-back tip is an ancestor of the advanced tip").toBe(0);

    // A workspace created after this boot seeds from the advanced tip and
    // carries the content the stale baseline was missing.
    const loaded = loadRoleBundle("manager")!;
    const bundle = loadRoleBundleAtCommit(dir, advancedTip, {
      pluginName: "manager",
      description: loaded.manifest.description,
    });
    expect(bundle.skills.map((s) => s.name)).toContain("bootstrap-interview");
    expect(bundle).toEqual(inMemoryBundle("manager"));
  });

  it("makes no new commit when tips are already current (idempotent across a double boot)", () => {
    materializeUpstreamRoleRepo(dir);
    const first = ensureUpstreamRoleRepo(dir);
    const second = ensureUpstreamRoleRepo(dir);

    for (const name of ["manager", "worker"]) {
      expect(second.forks.get(name)!.sha).toBe(first.forks.get(name)!.sha);
    }
  });

  it("keeps a pre-existing pin's old sha resolvable after the branch advances", () => {
    materializeUpstreamRoleRepo(dir);
    const oldSha = rollBackManagerDefault();

    ensureUpstreamRoleRepo(dir);

    const oldContract = loadRoleBundleAtCommit(dir, oldSha, { pluginName: "manager" });
    expect(oldContract.skills.map((s) => s.name)).not.toContain("bootstrap-interview");
  });

  it("never touches a fork branch (only -default/base baseline branches)", () => {
    materializeUpstreamRoleRepo(dir);
    // Simulate a workspace fork: a role branch off worker-default, edited.
    git(dir, "checkout", "-q", "-b", "worker", "worker-default");
    writeFileSync(join(dir, "framing.md"), "a locally-edited framing\n");
    git(dir, "add", "-A");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "worker: local edit");
    const forkTip = git(dir, "rev-parse", "worker").trim();

    ensureUpstreamRoleRepo(dir);

    expect(git(dir, "rev-parse", "worker").trim()).toBe(forkTip);
  });
});
