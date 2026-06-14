// #660 — spawn-worktree fast-follows (two residuals from #659 freeze trio)
//
// TA: git fetch failure mislabeled as worktree-collision → wrong recovery hint
// TB1: setIdentity failure on first-attach leaves no durable strand
// TB2: (scope guard) recreate path is unaffected by the Part B boundary extension

import { describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { resolveSpawnCwd } from "../src/spawn-worktree.ts";
import { buildHarness, teardown } from "./_spawn-harness.ts";

function gitRun(repoPath: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
}

// Minimal repo with a commit — no package.json, no install step.
function gitInit(repoPath: string): void {
  gitRun(repoPath, ["init", "-q", "-b", "main"]);
  gitRun(repoPath, ["config", "user.email", "test@clobber.invalid"]);
  gitRun(repoPath, ["config", "user.name", "clobber-test"]);
  gitRun(repoPath, ["commit", "--allow-empty", "-q", "-m", "root"]);
}

// Repo whose origin resolveOriginDefault will see but that will fail when
// git fetch runs — simulates a network/auth fault without hitting the network.
function gitInitUnreachableOrigin(repoPath: string): void {
  gitInit(repoPath);
  // Add an origin pointing at a path guaranteed not to exist.
  gitRun(repoPath, ["remote", "add", "origin", "/clobber-test-nonexistent-remote-will-never-exist"]);
  // Create the refs/remotes/origin/HEAD symref so resolveOriginDefault() finds
  // an origin and the fetch path in createWorktree executes. The symref itself
  // needs no actual target — git just stores the pointer.
  gitRun(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
}

// ─── TA ──────────────────────────────────────────────────────────────────────

describe("TA (#660): git fetch failure is NOT a worktree collision", () => {
  it("unreachable origin surfaces fetch-failed (503), not collision (409)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitUnreachableOrigin(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "fetch-fail-test", prompt: "go" },
    });

    // Pre-fix: fetch failure throws WorktreeError("collision") → 409 "worktree-collision".
    // Post-fix: WorktreeError("fetch-failed") → 503 "worktree-fetch-failed".
    expect(res.statusCode).not.toBe(409);
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error?: string; branch?: string; path?: string; stderr?: string };
    expect(body.error).not.toBe("worktree-collision");
    expect(body.error).toBe("worktree-fetch-failed");
    // stderr is preserved (#656 structured-error contract).
    expect(typeof body.stderr).toBe("string");
    expect(body.branch).toBeDefined();
    expect(body.path).toBeDefined();

    await teardown(h);
  });

  it("a real worktree-add collision still surfaces 409 worktree-collision (regression guard)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    // Simple local repo — no origin, no fetch step.
    gitInit(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);

    const first = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "dup", prompt: "go" },
    });
    expect(first.statusCode).toBe(200);

    // Second spawn with the same label → git worktree add fails (branch/path exist).
    const second = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "dup", prompt: "go" },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error?: string };
    expect(body.error).toBe("worktree-collision");

    await teardown(h);
  });
});

// ─── TB1 ─────────────────────────────────────────────────────────────────────

describe("TB1 (#660): setIdentity failure on first-attach rolls back worktree+branch", () => {
  it("throwing setIdentity leaves no durable worktree or branch", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id, label: "strand-test" });

    let worktreePathAtThrow: string | undefined;
    let branchAtThrow: string | undefined;
    const throwingSetIdentity = (branch: string, path: string): void => {
      worktreePathAtThrow = path;
      branchAtThrow = branch;
      throw new Error("simulated SQLite identity persist failure");
    };

    await expect(
      resolveSpawnCwd(ws, agent, "attach", throwingSetIdentity, 30_000),
    ).rejects.toThrow("simulated SQLite identity persist failure");

    // setIdentity was called — confirms the test reached the identity-persist step.
    expect(worktreePathAtThrow).toBeDefined();
    expect(branchAtThrow).toBeDefined();

    // Pre-fix: worktree and branch are still present (strand).
    // Post-fix: both must be rolled back so a same-label retry starts clean.
    expect(existsSync(worktreePathAtThrow!)).toBe(false);
    const branchOut = Bun.spawnSync(
      ["git", "-C", h.repoPath, "branch", "--list", branchAtThrow!],
      { stdout: "pipe", stderr: "pipe" },
    ).stdout.toString().trim();
    expect(branchOut).toBe("");

    await teardown(h);
  });
});

// ─── TB2 ─────────────────────────────────────────────────────────────────────

describe("TB2 (#660): recreate path is unaffected — setIdentity never called, no rollback", () => {
  it("recreate-path spawn with a throwing setIdentity succeeds; worktree is present", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });

    // Seed an agent with stored identity whose path is missing — triggers recreate path.
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id, label: "recreate-scope-guard" });
    const storedBranch = "recreate-scope-guard";
    const storedPath = join(h.repoPath, ".clobber", "worktrees", "recreate-scope-guard");
    h.agents.setWorktreeIdentity(agent.id, storedBranch, storedPath);
    // storedPath does NOT exist on disk — triggers the recreate branch.

    let setIdentityCalled = false;
    const throwingSetIdentity = (_branch: string, _path: string): void => {
      setIdentityCalled = true;
      throw new Error("setIdentity must not be called on recreate path");
    };

    const agentWithIdentity = h.agents.get(agent.id)!;
    const cwd = await resolveSpawnCwd(ws, agentWithIdentity, "attach", throwingSetIdentity, 30_000);

    // The recreate path must NOT call setIdentity.
    expect(setIdentityCalled).toBe(false);
    // The returned cwd is the stored path, now recreated on disk.
    expect(cwd).toBe(storedPath);
    expect(existsSync(storedPath)).toBe(true);

    rmSync(storedPath, { recursive: true, force: true });
    Bun.spawnSync(["git", "-C", h.repoPath, "branch", "-D", storedBranch], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "-C", h.repoPath, "worktree", "prune"], { stdout: "pipe", stderr: "pipe" });
    await teardown(h);
  });
});
