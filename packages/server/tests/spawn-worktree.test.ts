import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { seedNodeModules } from "../src/spawn-worktree.ts";
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

// Worktrees land inside repoPath at .clobber/worktrees/, so teardown(h)
// (which removes repoPath recursively) cleans them up automatically.
// This helper is kept for the rmSync calls below which are now no-ops but
// harmless (force: true).
function worktreesRoot(repoPath: string): string {
  return join(repoPath, ".clobber", "worktrees");
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
    // silently reuse — it surfaces the failure as a structured 409 (#656 AC5).
    const second = await spawnWorker(h, ws.id, role.id, "dup");
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error?: string };
    expect(body.error).toBe("worktree-collision");
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

describe("spawn_worktree (#635): persist worktree identity — derive once, read stored", () => {
  it("(a) first-attach stores worktree_branch and worktree_path on the agent row", async () => {
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
    const agentId = (res.json() as { agent_id: string }).agent_id;

    const row = h.db
      .prepare("SELECT worktree_branch, worktree_path FROM agents WHERE id = ?")
      .get(agentId) as { worktree_branch: string | null; worktree_path: string | null };
    expect(row.worktree_branch).toBe("42");
    expect(row.worktree_path).toBe(h.records[0]!.req.cwd);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  it("(a2) second attach reads stored identity without re-deriving — cwd is unchanged", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const first = await spawnWorker(h, ws.id, role.id, "manager");
    expect(first.statusCode).toBe(200);
    const agentId = (first.json() as { agent_id: string }).agent_id;
    const firstCwd = h.records[0]!.req.cwd;
    await h.records[0]!.exit(0);

    // Wake: must return the stored path, not re-derive.
    // Verify by confirming stored columns match and cwd is unchanged on second attach.
    const row = h.db
      .prepare("SELECT worktree_branch, worktree_path FROM agents WHERE id = ?")
      .get(agentId) as { worktree_branch: string | null; worktree_path: string | null };
    expect(row.worktree_branch).toBe("manager");
    expect(row.worktree_path).toBe(firstCwd);

    const wake = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agentId}/wake`,
      payload: {},
    });
    expect(wake.statusCode).toBe(200);
    expect(h.records[1]!.req.cwd).toBe(firstCwd);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  it("(c) off→on flip — existing agent creates worktree on next attach (strand-victim fix #631)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);

    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "off" },
    });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // First wake: policy=off, cwd is the repo, no worktree on disk.
    const first = await spawnWorker(h, ws.id, role.id, "manager");
    expect(first.statusCode).toBe(200);
    const agentId = (first.json() as { agent_id: string }).agent_id;
    expect(h.records[0]!.req.cwd).toBe(h.repoPath);
    await h.records[0]!.exit(0);

    // Flip policy on.
    h.workspaces.updateConfig(ws.id, { spawn_worktree: { kind: "on" } });

    // Second wake: agent has no stored identity; policy=on; mode=attach.
    // Must create the worktree now rather than returning a non-existent path.
    const wake = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agentId}/wake`,
      payload: {},
    });
    expect(wake.statusCode).toBe(200);
    const cwd = h.records[1]!.req.cwd;
    expect(cwd).not.toBe(h.repoPath);
    expect(existsSync(cwd)).toBe(true);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });
});

// Bun workspace fixture: root + packages/{shared,app} where app depends on @x/shared.
// After `bun install` in repoPath, packages/app/node_modules/@x/shared is a relative
// symlink (../../../shared) that resolves inside whichever repo root contains the link.
function gitInitWithWorkspaceDep(repoPath: string): void {
  gitInit(repoPath);
  writeFileSync(
    join(repoPath, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  mkdirSync(join(repoPath, "packages", "shared"), { recursive: true });
  writeFileSync(
    join(repoPath, "packages", "shared", "package.json"),
    JSON.stringify({ name: "@x/shared", version: "1.0.0" }),
  );
  writeFileSync(join(repoPath, "packages", "shared", "index.js"), "// initial\n");
  mkdirSync(join(repoPath, "packages", "app"), { recursive: true });
  writeFileSync(
    join(repoPath, "packages", "app", "package.json"),
    JSON.stringify({ name: "@x/app", version: "1.0.0", dependencies: { "@x/shared": "workspace:*" } }),
  );
  gitRun(repoPath, ["add", "-A"]);
  gitRun(repoPath, ["commit", "-q", "-m", "add workspace packages"]);
}

describe("spawn_worktree (#664): seed node_modules from parent before installDeps", () => {
  // AC2: workspace symlinks preserved by cp -al resolve into the worktree, not the parent.
  it("AC2: seeded worktree — @x/shared symlink resolves into worktree's packages/shared (content marker)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitWithWorkspaceDep(h.repoPath);

    // Materialize parent node_modules (source for cp -al).
    Bun.spawnSync(["bun", "install"], { cwd: h.repoPath, stdout: "ignore", stderr: "ignore" });

    // Distinct content in parent so any wrong-source resolution is detectable.
    writeFileSync(join(h.repoPath, "packages", "shared", "index.js"), "// parent-marker\n");

    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await spawnWorker(h, ws.id, role.id, "664-ac2");
    expect(res.statusCode).toBe(200);

    const cwd = h.records[0]!.req.cwd;

    // Write worktree-specific marker post-spawn (worktree's packages/shared is from git checkout).
    writeFileSync(join(cwd, "packages", "shared", "index.js"), "// worktree-marker\n");

    const link = join(cwd, "packages", "app", "node_modules", "@x", "shared");
    // Symlink must exist (seed or install put it there).
    expect(existsSync(link)).toBe(true);
    // realpath resolves into the WORKTREE, never the parent.
    expect(realpathSync(link)).toBe(realpathSync(join(cwd, "packages", "shared")));
    expect(realpathSync(link)).not.toBe(realpathSync(join(h.repoPath, "packages", "shared")));
    // Content marker: reading through the link yields the WORKTREE's content.
    expect(readFileSync(join(link, "index.js"), "utf-8")).toBe("// worktree-marker\n");
    expect(readFileSync(join(h.repoPath, "packages", "shared", "index.js"), "utf-8")).toBe("// parent-marker\n");

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  // AC1: same-FS + parent node_modules present → seed runs (cp -al produces hardlinks).
  it("AC1: same-FS — sentinel file hardlinked into worktree proves cp -al ran before installDeps", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitWithWorkspaceDep(h.repoPath);

    Bun.spawnSync(["bun", "install"], { cwd: h.repoPath, stdout: "ignore", stderr: "ignore" });

    // Sentinel file in parent root node_modules — bun install would never create this.
    const sentinelSrc = join(h.repoPath, "node_modules", ".clobber-seed-sentinel");
    writeFileSync(sentinelSrc, "sentinel-content");

    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await spawnWorker(h, ws.id, role.id, "664-ac1");
    expect(res.statusCode).toBe(200);

    const cwd = h.records[0]!.req.cwd;
    const sentinelDst = join(cwd, "node_modules", ".clobber-seed-sentinel");

    // Sentinel must be present in the worktree (cp -al seeded it).
    expect(existsSync(sentinelDst)).toBe(true);
    // Same inode = hardlink, proving cp -al ran (not a bun install side effect).
    expect(statSync(sentinelDst).ino).toBe(statSync(sentinelSrc).ino);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  // AC3a: cross-FS (injected st_dev mismatch) → seed skipped, worktree counterpart absent.
  it("AC3a: cross-FS st_dev mismatch → seedNodeModules skips cp -al, no worktree node_modules created", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-test-664-ac3a-"));
    const worktreePath = mkdtempSync(join(tmpdir(), "clobber-test-664-ac3a-wt-"));
    try {
      const srcNM = join(repoPath, "node_modules");
      mkdirSync(srcNM);
      writeFileSync(join(srcNM, ".keep"), "");

      // Inject differing dev numbers to simulate cross-FS without needing two mounts.
      let callIdx = 0;
      const statDev = (_p: string) => (callIdx++ % 2 === 0 ? 100 : 200);

      seedNodeModules(repoPath, worktreePath, statDev);

      expect(existsSync(join(worktreePath, "node_modules"))).toBe(false);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  // AC3b: no parent node_modules → seed skips silently, no error.
  it("AC3b: absent parent node_modules → seedNodeModules returns without error or worktree side-effects", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-test-664-ac3b-"));
    const worktreePath = mkdtempSync(join(tmpdir(), "clobber-test-664-ac3b-wt-"));
    try {
      // No node_modules at all in parent.
      expect(() => seedNodeModules(repoPath, worktreePath)).not.toThrow();
      expect(existsSync(join(worktreePath, "node_modules"))).toBe(false);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
