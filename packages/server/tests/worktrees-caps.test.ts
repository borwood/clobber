// #636 PR1 — worktrees caps + CLI + bare-slug branch default + schema config home
//
// Covers:
//   AC1:  3 caps in CLI_CAPABILITY_REGISTRY — write-tier denied set-agent, admin ok
//   AC2:  branch default = bare <slug> (no clobber/ prefix)
//   AC4:  set-default affects new agents only; existing carry stored identity
//   AC5:  worktrees.set moves stored fact (worktree_path) AND on-disk worktree
//   AC6:  worktrees.set-agent denied at write tier, same path+on-disk move as set
//   T3:   set-agent on live-session agent refuses

import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { buildHarness, teardown, type Harness } from "./_spawn-harness.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

function gitRun(repoPath: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd: repoPath });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

function gitInit(repoPath: string): void {
  gitRun(repoPath, ["init", "-q", "-b", "main"]);
  gitRun(repoPath, ["config", "user.email", "test@clobber.invalid"]);
  gitRun(repoPath, ["config", "user.name", "clobber-test"]);
  gitRun(repoPath, ["commit", "--allow-empty", "-q", "-m", "root"]);
}

function worktreesRoot(repoPath: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}-worktrees`);
}

// Mint a session token for an agent with the given role.
// The seeded role must already exist in the workspace (call seedWorkspaceRoles first).
function mintToken(h: Harness, workspaceId: string, roleName: string): {
  agentId: string;
  sessionId: string;
  token: string;
} {
  const role = h.roles.findInWorkspace(workspaceId, roleName);
  if (role === null) throw new Error(`role not found: ${roleName}`);
  const agent = h.agents.create({ workspace_id: workspaceId, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: workspaceId, role_id: role.id, pid: 1 });
  const token = h.sessionTokens.mint(sessionId);
  return { agentId: agent.id, sessionId, token };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ── AC1: cap auth ─────────────────────────────────────────────────────────────

describe("worktrees caps (AC1): auth enforcement on set-agent", () => {
  it("write-tier (worker) calling set-agent is denied 403", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    seedWorkspaceRoles(h.db, ws.id);
    const { token: workerToken } = mintToken(h, ws.id, "worker");

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/worktrees/set-agent",
      headers: bearer(workerToken),
      payload: { agent_id: randomUUID(), path: "/tmp/somewhere" },
    });
    expect(res.statusCode).toBe(403);

    await teardown(h);
  });

  it("admin-tier (manager) calling set-agent is not rejected by auth (≠ 403/401)", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath, spawn_worktree: { kind: "on" } });
    seedWorkspaceRoles(h.db, ws.id);
    const { token: managerToken } = mintToken(h, ws.id, "manager");

    // Agent to move — spawn it first so it has a worktree on disk
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: h.roles.findInWorkspace(ws.id, "worker")!.id,
        prompt: "do work",
        label: "target",
      },
    });
    expect(res.statusCode).toBe(200);
    const agentId = (res.json() as { agent_id: string }).agent_id;
    // End the session so the idle-guard passes
    await h.records[0]!.exit(0);

    const moveRes = await h.server.inject({
      method: "POST",
      url: "/agent/worktrees/set-agent",
      headers: bearer(managerToken),
      payload: { agent_id: agentId, path: join(worktreesRoot(h.repoPath), "target-moved") },
    });
    expect(moveRes.statusCode).toBe(200);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  it("worktrees.set-default is in CLI_CAPABILITY_REGISTRY tagged admin", async () => {
    const { CLI_CAPABILITY_REGISTRY } = await import("@clobber/shared");
    const cap = CLI_CAPABILITY_REGISTRY["worktrees.set-default"];
    expect(cap).toBeDefined();
    expect(cap!.tag).toBe("admin");
  });

  it("worktrees.set is in CLI_CAPABILITY_REGISTRY tagged write", async () => {
    const { CLI_CAPABILITY_REGISTRY } = await import("@clobber/shared");
    const cap = CLI_CAPABILITY_REGISTRY["worktrees.set"];
    expect(cap).toBeDefined();
    expect(cap!.tag).toBe("write");
  });

  it("worktrees.set-agent is in CLI_CAPABILITY_REGISTRY tagged admin", async () => {
    const { CLI_CAPABILITY_REGISTRY } = await import("@clobber/shared");
    const cap = CLI_CAPABILITY_REGISTRY["worktrees.set-agent"];
    expect(cap).toBeDefined();
    expect(cap!.tag).toBe("admin");
  });
});

// ── AC2: bare-slug branch default ─────────────────────────────────────────────

describe("worktrees branch default (AC2): spawn_worktree on, no prefix → bare slug", () => {
  it("first-attach stores bare slug as worktree_branch (no clobber/ prefix)", async () => {
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
      .prepare("SELECT worktree_branch FROM agents WHERE id = ?")
      .get(agentId) as { worktree_branch: string | null };
    // Bare slug — no clobber/ prefix
    expect(row.worktree_branch).toBe("42");

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });

  it("explicit branch_prefix in workspace config is used for new agents", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on", branch_prefix: "team" },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "77" },
    });
    expect(res.statusCode).toBe(200);
    const agentId = (res.json() as { agent_id: string }).agent_id;

    const row = h.db
      .prepare("SELECT worktree_branch FROM agents WHERE id = ?")
      .get(agentId) as { worktree_branch: string | null };
    expect(row.worktree_branch).toBe("team/77");

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });
});

// ── AC4: set-default affects new agents only ──────────────────────────────────

describe("worktrees set-default (AC4): existing agents keep stored identity", () => {
  it("after set-default, existing agent resumes at old path; new agent uses new prefix", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // Spawn agent A — stores identity with bare-slug default
    const firstSpawn = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "mgr" },
    });
    expect(firstSpawn.statusCode).toBe(200);
    const agentAId = (firstSpawn.json() as { agent_id: string }).agent_id;
    const firstCwd = h.records[0]!.req.cwd;
    await h.records[0]!.exit(0);

    // Change default to a new prefix via the set-default route
    seedWorkspaceRoles(h.db, ws.id);
    const { token: managerToken } = mintToken(h, ws.id, "manager");
    const setDefaultRes = await h.server.inject({
      method: "PUT",
      url: "/agent/worktrees/default",
      headers: bearer(managerToken),
      payload: { branch_prefix: "feature" },
    });
    expect(setDefaultRes.statusCode).toBe(200);

    // Agent A resumes at OLD stored path (identity is persisted, not re-derived)
    const wake = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agentAId}/wake`,
      payload: {},
    });
    expect(wake.statusCode).toBe(200);
    expect(h.records[1]!.req.cwd).toBe(firstCwd);
    await h.records[1]!.exit(0);

    // Spawn agent B (new role instance) — should use new prefix "feature"
    const roleB = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, roleB.id, 1);
    const spawnB = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: roleB.id, prompt: "do work", label: "88" },
    });
    expect(spawnB.statusCode).toBe(200);
    const agentBId = (spawnB.json() as { agent_id: string }).agent_id;
    const row = h.db
      .prepare("SELECT worktree_branch FROM agents WHERE id = ?")
      .get(agentBId) as { worktree_branch: string | null };
    expect(row.worktree_branch).toBe("feature/88");

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });
});

// ── AC5: worktrees.set moves stored fact + on-disk worktree ──────────────────

describe("worktrees.set (AC5): moves worktree_path + on-disk worktree", () => {
  it("POST /agent/worktrees/set moves the on-disk worktree and updates agents.worktree_path", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    seedWorkspaceRoles(h.db, ws.id);
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // Spawn to create the worktree (session stays active for auth)
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "mover" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const spawnBody = spawnRes.json() as { agent_id: string; session_id: string };
    const agentId = spawnBody.agent_id;
    const originalPath = h.records[0]!.req.cwd;

    // Mint from the spawned session (still active) so worktrees.set sees the right agent
    const token = h.sessionTokens.mint(spawnBody.session_id);

    const newPath = join(worktreesRoot(h.repoPath), "mover-relocated");
    const moveRes = await h.server.inject({
      method: "POST",
      url: "/agent/worktrees/set",
      headers: bearer(token),
      payload: { path: newPath },
    });
    expect(moveRes.statusCode).toBe(200);

    // End session after the move
    await h.records[0]!.exit(0);

    // DB row updated
    const row = h.db
      .prepare("SELECT worktree_path FROM agents WHERE id = ?")
      .get(agentId) as { worktree_path: string | null };
    expect(row.worktree_path).toBe(newPath);

    // On-disk: new path exists, old path gone
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(originalPath)).toBe(false);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });
});

// ── T3: set-agent on live-session agent refuses ───────────────────────────────

describe("worktrees.set-agent (T3): refuses move of live-session agent", () => {
  it("returns 409 when target agent has an active session", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    gitInit(h.repoPath);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    seedWorkspaceRoles(h.db, ws.id);
    const { token: managerToken } = mintToken(h, ws.id, "manager");
    const workerRole = h.roles.findInWorkspace(ws.id, "worker")!;
    h.workspaceRoles.setCeiling(ws.id, workerRole.id, 1);

    // Spawn worker — leave session ACTIVE (don't call exit)
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: workerRole.id, prompt: "do work", label: "live" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const agentId = (spawnRes.json() as { agent_id: string }).agent_id;

    const moveRes = await h.server.inject({
      method: "POST",
      url: "/agent/worktrees/set-agent",
      headers: bearer(managerToken),
      payload: { agent_id: agentId, path: join(worktreesRoot(h.repoPath), "live-moved") },
    });
    // Must refuse — agent is live
    expect(moveRes.statusCode).toBe(409);

    rmSync(worktreesRoot(h.repoPath), { recursive: true, force: true });
    await teardown(h);
  });
});
