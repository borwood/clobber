import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { buildHarness, teardown, type Harness } from "./_spawn-harness.ts";

function gitRun(repoPath: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd: repoPath });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

// The harness' repoPath is a bare temp dir; `git worktree add` needs a real
// repo with at least one commit. Initialize one in place.
function gitInit(repoPath: string): void {
  gitRun(repoPath, ["init", "-q", "-b", "main"]);
  gitRun(repoPath, ["config", "user.email", "test@clobber.invalid"]);
  gitRun(repoPath, ["config", "user.name", "clobber-test"]);
  gitRun(repoPath, ["commit", "--allow-empty", "-q", "-m", "root"]);
}

// Initialize a repo whose committed tree carries a package.json with a single
// offline `file:` dependency. After `git worktree add`, the worktree inherits
// the manifest + the local dep package, so a `bun install` resolves it with no
// network — node_modules/<dep> appearing proves the create path installed.
function gitInitWithLocalDep(repoPath: string): void {
  gitInit(repoPath);
  writeFileSync(
    join(repoPath, "package.json"),
    JSON.stringify({
      name: "root",
      private: true,
      dependencies: { localdep: "file:./localdep" },
    }),
  );
  mkdirSync(join(repoPath, "localdep"));
  writeFileSync(
    join(repoPath, "localdep", "package.json"),
    JSON.stringify({ name: "localdep", version: "1.0.0" }),
  );
  gitRun(repoPath, ["add", "-A"]);
  gitRun(repoPath, ["commit", "-q", "-m", "add package with local dep"]);
}

// Worktrees land beside the repo at <dirname>/<basename>-worktrees/, outside
// repoPath — so teardown(h) (which only removes repoPath) won't reach them.
function worktreesRoot(repoPath: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}-worktrees`);
}

async function spawnWorker(
  h: Harness,
  workspaceId: string,
  roleId: string,
  label: string,
) {
  return h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: workspaceId, role_id: roleId, prompt: "do work", label },
  });
}

describe("spawn_worktree (#174): per-workspace auto-worktree on spawn", () => {
  it("default (off): the worker's cwd is the repo itself — no behavior change", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await spawnWorker(h, ws.id, role.id, "42");
    expect(res.statusCode).toBe(200);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.req.cwd).toBe(h.repoPath);

    await teardown(h);
  });

  it("on: spawning a worker creates a git worktree and points the worker's cwd at it", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await spawnWorker(h, ws.id, role.id, "42");
    expect(res.statusCode).toBe(200);
    expect(h.records).toHaveLength(1);

    const cwd = h.records[0]!.req.cwd;
    // cwd must be a freshly-created worktree, not the shared checkout.
    expect(cwd).not.toBe(h.repoPath);
    expect(existsSync(cwd)).toBe(true);
    // A linked worktree carries a `.git` *file* (gitdir pointer), not a dir.
    expect(existsSync(join(cwd, ".git"))).toBe(true);
    const linked = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: h.repoPath,
    }).stdout.toString();
    expect(linked).toContain(cwd);

    await teardown(h);
  });

  it("on: a colliding branch/worktree throws loudly — no silent reuse", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);

    const first = await spawnWorker(h, ws.id, role.id, "dup");
    expect(first.statusCode).toBe(200);

    // Same label derives the same branch + path; the second spawn must not
    // silently reuse — it surfaces the failure (500) rather than nesting.
    const second = await spawnWorker(h, ws.id, role.id, "dup");
    expect(second.statusCode).toBe(500);
    expect(h.records).toHaveLength(1);

    await teardown(h);
  });

  it("on: a persistent agent's second attach (wake) reuses its worktree instead of re-creating (#217)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // First attach: the persistent agent boots, creating its worktree.
    const first = await spawnWorker(h, ws.id, role.id, "manager");
    expect(first.statusCode).toBe(200);
    const agentId = (first.json() as { agent_id: string }).agent_id;
    const firstCwd = h.records[0]!.req.cwd;
    expect(firstCwd).not.toBe(h.repoPath);

    // The first session ends; the agent goes idle (the worktree stays — #198).
    await h.records[0]!.exit(0);

    // Waking the SAME agent is a second attach. It must resolve to the existing
    // worktree, not re-run `git worktree add` (which git refuses → regression).
    const wake = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agentId}/wake`,
      payload: {},
    });
    expect(wake.statusCode).toBe(200);
    expect(h.records).toHaveLength(2);
    expect(h.records[1]!.req.cwd).toBe(firstCwd);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  it("on: the create path installs deps so the worker can build immediately (#201)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitWithLocalDep(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await spawnWorker(h, ws.id, role.id, "201");
    expect(res.statusCode).toBe(200);

    const cwd = h.records[0]!.req.cwd;
    // A fresh worktree has no node_modules; if the create path ran `bun
    // install`, the file: dependency resolves into the worktree's tree.
    expect(existsSync(join(cwd, "node_modules", "localdep"))).toBe(true);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  it("on: when local main lags origin/main, worktree is based on origin HEAD not stale local (#500)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const remotePath = mkdtempSync(join(tmpdir(), "clobber-test-origin-"));

    // Remote: initial commit A (simulates GitHub "origin")
    gitRun(remotePath, ["init", "-q", "-b", "main"]);
    gitRun(remotePath, ["config", "user.email", "test@clobber.invalid"]);
    gitRun(remotePath, ["config", "user.name", "clobber-test"]);
    gitRun(remotePath, ["commit", "--allow-empty", "-q", "-m", "root"]);

    // Local: wired to remote, local main at commit A (simulates post-clone state)
    gitRun(h.repoPath, ["init", "-q", "-b", "main"]);
    gitRun(h.repoPath, ["config", "user.email", "test@clobber.invalid"]);
    gitRun(h.repoPath, ["config", "user.name", "clobber-test"]);
    gitRun(h.repoPath, ["remote", "add", "origin", remotePath]);
    gitRun(h.repoPath, ["fetch", "origin"]);
    // Point local main at commit A (update-ref works on an unborn branch)
    gitRun(h.repoPath, ["update-ref", "refs/heads/main", "refs/remotes/origin/main"]);
    // Set origin/HEAD → origin/main (git clone does this automatically)
    gitRun(h.repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    // Remote advances to commit B (simulates `gh pr merge` — local is NOT refetched)
    gitRun(remotePath, ["commit", "--allow-empty", "-q", "-m", "pr-merge"]);
    const remoteHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: remotePath,
    }).stdout.toString().trim();

    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await spawnWorker(h, ws.id, role.id, "500");
    expect(res.statusCode).toBe(200);

    const cwd = h.records[0]!.req.cwd;
    const worktreeHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd,
    }).stdout.toString().trim();
    // Must land on origin's HEAD (commit B), not stale local main (commit A)
    expect(worktreeHead).toBe(remoteHead);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    rmSync(remotePath, { recursive: true, force: true });
    await teardown(h);
  });
});
