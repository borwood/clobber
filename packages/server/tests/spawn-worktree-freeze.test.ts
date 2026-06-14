// #657/#658/#656 — spawn-worktree freeze trio
//
// T1 (AC1): async install doesn't block concurrent requests
// T2 (AC3): rollback after failed install enables same-label self-recovery
// T3 (AC4): recreate-path rollback does NOT clear the stored identity row
// T4 (AC5): install failure returns structured HTTP body, not opaque 500
// T5 (AC2): timed-out install fails the spawn instead of hanging forever

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { resolveSpawnCwd, WorktreeError } from "../src/spawn-worktree.ts";
import { buildHarness, teardown } from "./_spawn-harness.ts";

// ─── git fixture helpers ────────────────────────────────────────────────────

function gitRun(repoPath: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
}

function gitBase(repoPath: string): void {
  const tmp = mkdtempSync(join(tmpdir(), "clobber-freeze-repo-"));
  // Move the temp dir content into repoPath (repoPath already exists from harness)
  gitRun(repoPath, ["init", "-q", "-b", "main"]);
  gitRun(repoPath, ["config", "user.email", "test@clobber.invalid"]);
  gitRun(repoPath, ["config", "user.name", "clobber-test"]);
  writeFileSync(join(repoPath, ".gitignore"), ".clobber/\n");
  rmSync(tmp, { recursive: true, force: true });
}

function addLocalDep(repoPath: string): void {
  mkdirSync(join(repoPath, "localdep"), { recursive: true });
  writeFileSync(join(repoPath, "localdep", "package.json"), JSON.stringify({ name: "localdep", version: "1.0.0" }));
}

// Offline-resolvable dep + slow postinstall for T1.
function gitInitSlowInstall(repoPath: string, delayMs: number): void {
  gitBase(repoPath);
  addLocalDep(repoPath);
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({
    name: "root", private: true,
    scripts: { postinstall: `node -e "setTimeout(()=>{},${delayMs})"` },
    dependencies: { localdep: "file:./localdep" },
  }));
  gitRun(repoPath, ["add", "-A"]);
  gitRun(repoPath, ["commit", "-q", "-m", "root"]);
}

// Failing postinstall (exits 1) for T2/T4.
function gitInitFailingInstall(repoPath: string): void {
  gitBase(repoPath);
  addLocalDep(repoPath);
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({
    name: "root", private: true,
    scripts: { postinstall: `node -e "process.exit(1)"` },
    dependencies: { localdep: "file:./localdep" },
  }));
  gitRun(repoPath, ["add", "-A"]);
  gitRun(repoPath, ["commit", "-q", "-m", "root"]);
}

// Fix the repo so a second spawn succeeds (update package.json, re-commit).
function fixInstall(repoPath: string): void {
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({
    name: "root", private: true,
    dependencies: { localdep: "file:./localdep" },
  }));
  gitRun(repoPath, ["add", "-A"]);
  gitRun(repoPath, ["commit", "-q", "-m", "fix install"]);
}

// Hanging postinstall (timer-based, stdin-independent) for T5.
// setInterval keeps the event loop alive regardless of whether bun closes stdin on the child.
function gitInitHangingInstall(repoPath: string): void {
  gitBase(repoPath);
  addLocalDep(repoPath);
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({
    name: "root", private: true,
    scripts: { postinstall: `node -e "setInterval(() => {}, 1000)"` },
    dependencies: { localdep: "file:./localdep" },
  }));
  gitRun(repoPath, ["add", "-A"]);
  gitRun(repoPath, ["commit", "-q", "-m", "root"]);
}

// ─── T1 ─────────────────────────────────────────────────────────────────────

describe("T1 (AC1, #657): async install — concurrent request not blocked", () => {
  it("fast request completes before slow install; node_modules present after spawn", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitSlowInstall(h.repoPath, 600);

    const wsWorktree = h.workspaces.create({ name: "slow", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const wsFast = h.workspaces.create({ name: "fast", repo_path: h.repoPath, spawn_worktree: { kind: "off" } });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(wsWorktree.id, role.id, 1);
    h.workspaceRoles.setCeiling(wsFast.id, role.id, 1);

    let slowDoneAt: number | undefined;
    let fastDoneAt: number | undefined;

    const [slowRes, fastRes] = await Promise.all([
      h.server.inject({ method: "POST", url: "/spawn",
        payload: { workspace_id: wsWorktree.id, role_id: role.id, label: "slow-agent", prompt: "go" } })
        .then(r => { slowDoneAt = Date.now(); return r; }),
      // Start fast request after 80ms so slow spawn is in-flight (in the install phase)
      new Promise<void>(resolve => setTimeout(resolve, 80)).then(() =>
        h.server.inject({ method: "POST", url: "/spawn",
          payload: { workspace_id: wsFast.id, role_id: role.id, label: "fast-agent", prompt: "go" } })
          .then(r => { fastDoneAt = Date.now(); return r; })
      ),
    ]);

    expect(slowRes.statusCode).toBe(200);
    expect(fastRes.statusCode).toBe(200);
    // Post-fix: fast completes before slow (async install doesn't block event loop).
    // Pre-fix: Bun.spawnSync blocks — fast is queued behind slow → fastDoneAt > slowDoneAt.
    expect(fastDoneAt!).toBeLessThan(slowDoneAt!);

    // AC1-invariant: node_modules must exist when the spawn resolves.
    const slowBody = slowRes.json() as { agent_id: string };
    const slowAgent = h.agents.get(slowBody.agent_id)!;
    expect(existsSync(join(slowAgent.worktree_path!, "node_modules", "localdep"))).toBe(true);

    await teardown(h);
  });
});

// ─── T2 ─────────────────────────────────────────────────────────────────────

describe("T2 (AC3, #658): rollback — same-label retry self-recovers after failed install", () => {
  it("first spawn fails + rolls back; second spawn with same label succeeds", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitFailingInstall(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);

    // First spawn: install fails.
    const res1 = await h.server.inject({ method: "POST", url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "retry-test", prompt: "go" } });
    expect(res1.statusCode).not.toBe(200);
    const body1 = res1.json() as { error: string; branch: string; path: string };
    expect(body1.error).toBe("worktree-install-failed");

    // Git state is clean after rollback (branch deleted, path removed).
    // Pre-fix: branch and worktree were stranded here → second spawn 500s.
    const branchOut = Bun.spawnSync(
      ["git", "-C", h.repoPath, "branch", "--list", body1.branch],
      { stdout: "pipe" },
    ).stdout.toString().trim();
    expect(branchOut).toBe("");
    expect(existsSync(body1.path)).toBe(false);

    // Fix the repo so the second spawn can install successfully.
    fixInstall(h.repoPath);

    // Second spawn with same label must succeed (self-recovery).
    const res2 = await h.server.inject({ method: "POST", url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "retry-test", prompt: "go" } });
    expect(res2.statusCode).toBe(200);

    await teardown(h);
  });
});

// ─── T3 ─────────────────────────────────────────────────────────────────────

describe("T3 (AC4, #658): recreate-path rollback does NOT clear the stored identity row", () => {
  it("failed recreate rolls back worktree/branch but leaves agent identity row intact", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitFailingInstall(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });

    // Seed an agent with stored identity (recreate path triggers when worktree_path is missing).
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id, label: "recreate-test" });
    const storedBranch = "recreate-test";
    const storedPath = join(h.repoPath, ".clobber", "worktrees", "recreate-test");
    h.agents.setWorktreeIdentity(agent.id, storedBranch, storedPath);
    // storedPath does not exist on disk — triggers the recreate path.

    let setIdentityCalled = false;
    const agentWithIdentity = h.agents.get(agent.id)!;

    await expect(
      resolveSpawnCwd(ws, agentWithIdentity, "attach",
        () => { setIdentityCalled = true; },
        30_000,
      ),
    ).rejects.toBeInstanceOf(WorktreeError);

    // Worktree rolled back after failed recreate.
    expect(existsSync(storedPath)).toBe(false);
    const branchOut = Bun.spawnSync(
      ["git", "-C", h.repoPath, "branch", "--list", storedBranch],
      { stdout: "pipe" },
    ).stdout.toString().trim();
    expect(branchOut).toBe("");

    // Identity row unchanged — setIdentity was NOT called in the recreate path.
    expect(setIdentityCalled).toBe(false);
    const refreshed = h.agents.get(agent.id)!;
    expect(refreshed.worktree_branch).toBe(storedBranch);
    expect(refreshed.worktree_path).toBe(storedPath);

    await teardown(h);
  });
});

// ─── T4 ─────────────────────────────────────────────────────────────────────

describe("T4 (#656/AC5): install failure returns structured HTTP body, not opaque 500", () => {
  it("POST /spawn returns 422 with named error + branch/path/stderr", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitFailingInstall(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({ method: "POST", url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "error-shape", prompt: "go" } });

    // Pre-fix: Fastify's default error handler returns 500 with no useful body.
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error?: string; branch?: string; path?: string; stderr?: string };
    expect(body.error).toBe("worktree-install-failed");
    expect(typeof body.branch).toBe("string");
    expect(body.branch!.length).toBeGreaterThan(0);
    expect(typeof body.path).toBe("string");
    expect(body.path!.length).toBeGreaterThan(0);
    expect(typeof body.stderr).toBe("string");

    await teardown(h);
  });
});

// ─── T5 ─────────────────────────────────────────────────────────────────────

// T5 tests the timer directly via resolveSpawnCwd (same pattern as T3) rather
// than HTTP inject. The HTTP response shape for install-failed is already
// covered by T4; going through inject here would require the full
// prepareSpawnContext stack (materializeBundle, skills, etc.) which adds
// ~4s of cold I/O in the test environment and obscures the timeout signal.
describe("T5 (AC2, #657): timed-out install fails the spawn instead of hanging", () => {
  it("hung install is killed by timeout; WorktreeError thrown; worktree rolled back", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitHangingInstall(h.repoPath);

    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    const role = h.roles.create({ name: "worker", persistent: false });
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id, label: "timeout-test" });

    const started = Date.now();
    let caught: WorktreeError | undefined;
    try {
      // 800ms timeout — much less than the default 120s so the test is fast.
      await resolveSpawnCwd(ws, agent, "attach", () => {}, 800);
    } catch (e) {
      if (e instanceof WorktreeError) caught = e;
      else throw e;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeDefined();
    expect(caught!.kind).toBe("install-failed");
    // Pre-fix: Bun.spawnSync blocks the event loop; timer never fires; elapsed >> 8s.
    // Post-fix: async + Promise.race kills at ~800ms + rollback overhead.
    expect(elapsed).toBeLessThan(8_000);

    // Worktree rolled back after timeout.
    expect(existsSync(caught!.path)).toBe(false);
    const branchOut = Bun.spawnSync(
      ["git", "-C", h.repoPath, "branch", "--list", caught!.branch],
      { stdout: "pipe" },
    ).stdout.toString().trim();
    expect(branchOut).toBe("");

    await teardown(h);
  });
});
