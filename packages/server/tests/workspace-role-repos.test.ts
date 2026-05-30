import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeUpstreamRoleRepo, ensureUpstreamRoleRepo } from "../src/role-repo.ts";
import { createWorkspaceRoleRepos } from "../src/workspace-role-repos.ts";

// #351 / topology B (#350) — each workspace gets its OWN clone of the shared
// upstream role repo, with upstream wired as a remote so #265's adopt primitive
// is `git fetch upstream && git merge`. A clone preserves object SHAs, so a
// role pinned to an upstream fork tip resolves byte-identically from the clone;
// migrated commits (#351) are NEW objects that live only in the workspace clone.

function git(dir: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString();
}

describe("per-workspace role fork-repos (#351 topology B)", () => {
  let root: string;
  let upstreamDir: string;
  let reposBaseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clobber-ws-repos-"));
    upstreamDir = join(root, "upstream");
    reposBaseDir = join(root, "role-repos");
    materializeUpstreamRoleRepo(upstreamDir);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("clones the upstream into a per-workspace dir under the repos base", () => {
    const repos = createWorkspaceRoleRepos({ upstreamDir, reposBaseDir });
    const dir = repos.dirFor("ws-A");

    expect(dir).toBe(join(reposBaseDir, "ws-A"));
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("wires the upstream as a remote named 'upstream' (the #265 fetch+merge source)", () => {
    const repos = createWorkspaceRoleRepos({ upstreamDir, reposBaseDir });
    const dir = repos.dirFor("ws-A");

    const url = git(dir, "remote", "get-url", "upstream").trim();
    expect(url).toBe(upstreamDir);
  });

  it("preserves upstream fork SHAs so an upstream-pinned role resolves from the clone", () => {
    const upstream = ensureUpstreamRoleRepo(upstreamDir);
    const repos = createWorkspaceRoleRepos({ upstreamDir, reposBaseDir });
    const dir = repos.dirFor("ws-A");

    for (const fork of upstream.forks.values()) {
      // the object exists in the clone — `cat-file -e` exits 0 iff present
      const res = Bun.spawnSync(["git", "-C", dir, "cat-file", "-e", fork.sha], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(res.exitCode, `fork sha ${fork.sha} present in clone`).toBe(0);
    }
  });

  it("isolates workspaces and is idempotent (a second call does not re-clone)", () => {
    const repos = createWorkspaceRoleRepos({ upstreamDir, reposBaseDir });
    const a1 = repos.dirFor("ws-A");
    const b = repos.dirFor("ws-B");
    expect(a1).not.toBe(b);

    // Drop a marker; a re-clone would wipe the dir and lose it.
    git(a1, "config", "clobber.marker", "kept");
    const a2 = repos.dirFor("ws-A");
    expect(a2).toBe(a1);
    expect(git(a2, "config", "clobber.marker").trim()).toBe("kept");
  });
});
