// #636 PR2 — relocate agent worktrees to .clobber/worktrees/<slug>
//
// AC3: path-identity — worktreeRootFor(repo, label, policy) and the path
//      deriveWorktree persists are IDENTICAL strings.
// AC8: non-inert relocation — real spawn with spawn_worktree:on + .clobber/
//      default → (a) path inside repo, (b) parent git status clean, (c) bun
//      install puts node_modules INSIDE worktree, (d) correct branch.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { worktreeRootFor } from "../src/spawn-worktree.ts";
import { buildHarness, teardown } from "./_spawn-harness.ts";

function gitRun(repoPath: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd: repoPath });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

// Init with .clobber/ gitignored (as in the real clobber repo) and a local
// file: dep so bun install resolves without network access.
function gitInitWithGitignoreAndLocalDep(repoPath: string): void {
  gitRun(repoPath, ["init", "-q", "-b", "main"]);
  gitRun(repoPath, ["config", "user.email", "test@clobber.invalid"]);
  gitRun(repoPath, ["config", "user.name", "clobber-test"]);
  writeFileSync(join(repoPath, ".gitignore"), ".clobber/\n");
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
  gitRun(repoPath, ["commit", "-q", "-m", "root"]);
}

function gitInit(repoPath: string): void {
  gitRun(repoPath, ["init", "-q", "-b", "main"]);
  gitRun(repoPath, ["config", "user.email", "test@clobber.invalid"]);
  gitRun(repoPath, ["config", "user.name", "clobber-test"]);
  gitRun(repoPath, ["commit", "--allow-empty", "-q", "-m", "root"]);
}

describe("spawn_worktree relocation (#636 PR2): .clobber/worktrees/ default", () => {
  it("AC3: worktreeRootFor matches persisted worktree_path and is inside repo at .clobber/worktrees/<slug>", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "42" },
    });
    expect(res.statusCode).toBe(200);
    const agentId = (res.json() as { agent_id: string }).agent_id;

    const row = h.db
      .prepare("SELECT worktree_path FROM agents WHERE id = ?")
      .get(agentId) as { worktree_path: string | null };

    // AC3: worktreeRootFor and deriveWorktree-persisted path are identical strings.
    const computed = worktreeRootFor(h.repoPath, "42", { kind: "on" });
    expect(row.worktree_path).toBe(computed);

    // The default root is .clobber/worktrees/<slug> inside the repo.
    expect(computed).toBe(join(h.repoPath, ".clobber", "worktrees", "42"));

    await teardown(h);
  });

  it("AC8(a): worktree path is inside repo at .clobber/worktrees/<slug>", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitWithGitignoreAndLocalDep(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "636" },
    });
    expect(res.statusCode).toBe(200);
    const cwd = h.records[0]!.req.cwd;

    expect(cwd).toBe(join(h.repoPath, ".clobber", "worktrees", "636"));
    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(join(cwd, ".git"))).toBe(true);

    await teardown(h);
  });

  it("AC8(b): parent git status --short is clean when worktree is under gitignored .clobber/", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitWithGitignoreAndLocalDep(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "status-check" },
    });
    expect(res.statusCode).toBe(200);

    const status = Bun.spawnSync(
      ["git", "status", "--short"],
      { cwd: h.repoPath, stdout: "pipe", stderr: "pipe" },
    ).stdout.toString().trim();
    expect(status).toBe("");

    await teardown(h);
  });

  it("AC8(c): bun install puts node_modules INSIDE the nested worktree (not parent)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitWithGitignoreAndLocalDep(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "deps-check" },
    });
    expect(res.statusCode).toBe(200);
    const cwd = h.records[0]!.req.cwd;

    // localdep resolves into the worktree's node_modules proving install ran there.
    expect(existsSync(join(cwd, "node_modules", "localdep"))).toBe(true);

    await teardown(h);
  });

  it("AC8(d): correct start-point branch (bare slug)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInitWithGitignoreAndLocalDep(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "branch-check" },
    });
    expect(res.statusCode).toBe(200);
    const cwd = h.records[0]!.req.cwd;

    const branch = Bun.spawnSync(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    ).stdout.toString().trim();
    expect(branch).toBe("branch-check");

    await teardown(h);
  });

  it("worktree_root config field overrides the default root", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "clobber-custom-root-"));
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on", worktree_root: tmpRoot },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "custom" },
    });
    expect(res.statusCode).toBe(200);
    const cwd = h.records[0]!.req.cwd;

    expect(cwd).toBe(join(tmpRoot, "custom"));
    expect(existsSync(cwd)).toBe(true);

    rmSync(tmpRoot, { recursive: true, force: true });
    await teardown(h);
  });
});
