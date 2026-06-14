// #643 — worktrees set-default read-merge-write + --worktree-root CLI flag
//
// Covers:
//   AC_RMW1:        setting branch_prefix only preserves existing worktree_root
//   AC_RMW2:        sequence set-both then set-prefix-only preserves root
//   AC_RMW_MIRROR:  setting worktree_root only preserves existing branch_prefix
//   AC_RESP:        response body includes worktree_root

import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { buildHarness, teardown, type Harness } from "./_spawn-harness.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

function mintToken(h: Harness, workspaceId: string, roleName: string): {
  token: string;
} {
  const role = h.roles.findInWorkspace(workspaceId, roleName);
  if (role === null) throw new Error(`role not found: ${roleName}`);
  const agent = h.agents.create({ workspace_id: workspaceId, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: workspaceId, role_id: role.id, pid: 1 });
  const token = h.sessionTokens.mint(sessionId);
  return { token };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ── AC_RMW1: set prefix-only, assert root survives ───────────────────────────

describe("worktrees set-default read-merge-write (AC_RMW1)", () => {
  it("setting branch_prefix does not clobber existing worktree_root", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on", worktree_root: "/mnt/fast/worktrees" },
    });
    seedWorkspaceRoles(h.db, ws.id);
    const { token } = mintToken(h, ws.id, "manager");

    // First: set branch_prefix only (no worktree_root in body)
    const res = await h.server.inject({
      method: "PUT",
      url: "/agent/worktrees/default",
      headers: bearer(token),
      payload: { branch_prefix: "clobber" },
    });
    expect(res.statusCode).toBe(200);

    // worktree_root must survive
    const workspace = h.workspaces.get(ws.id)!;
    expect(workspace.spawn_worktree).toMatchObject({
      kind: "on",
      branch_prefix: "clobber",
      worktree_root: "/mnt/fast/worktrees",
    });

    await teardown(h);
  });
});

// ── AC_RMW2: set root-only (via second call), assert prefix survives ──────────

describe("worktrees set-default read-merge-write (AC_RMW2)", () => {
  it("sequence set-both then set-prefix-only preserves root from first call", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    seedWorkspaceRoles(h.db, ws.id);
    const { token } = mintToken(h, ws.id, "manager");

    // Call 1: set both root + prefix
    const first = await h.server.inject({
      method: "PUT",
      url: "/agent/worktrees/default",
      headers: bearer(token),
      payload: { branch_prefix: "team", worktree_root: "/data/worktrees" },
    });
    expect(first.statusCode).toBe(200);

    // Call 2: set prefix only — root must survive
    const second = await h.server.inject({
      method: "PUT",
      url: "/agent/worktrees/default",
      headers: bearer(token),
      payload: { branch_prefix: "feature" },
    });
    expect(second.statusCode).toBe(200);

    const workspace = h.workspaces.get(ws.id)!;
    expect(workspace.spawn_worktree).toMatchObject({
      kind: "on",
      branch_prefix: "feature",
      worktree_root: "/data/worktrees",
    });

    await teardown(h);
  });
});

// ── AC_RMW_MIRROR: set root-only, assert prefix survives ─────────────────────

describe("worktrees set-default read-merge-write (AC_RMW_MIRROR)", () => {
  it("setting worktree_root only does not clobber existing branch_prefix", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on", branch_prefix: "team" },
    });
    seedWorkspaceRoles(h.db, ws.id);
    const { token } = mintToken(h, ws.id, "manager");

    // Root-only request — no branch_prefix in body (mirrors the CLI --worktree-root-only path)
    const res = await h.server.inject({
      method: "PUT",
      url: "/agent/worktrees/default",
      headers: bearer(token),
      payload: { worktree_root: "/data/fast" },
    });
    expect(res.statusCode).toBe(200);

    // branch_prefix must survive
    const workspace = h.workspaces.get(ws.id)!;
    expect(workspace.spawn_worktree).toMatchObject({
      kind: "on",
      branch_prefix: "team",
      worktree_root: "/data/fast",
    });

    await teardown(h);
  });
});

// ── AC_RESP: response body includes worktree_root ────────────────────────────

describe("worktrees set-default response (AC_RESP)", () => {
  it("response includes worktree_root when set", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    seedWorkspaceRoles(h.db, ws.id);
    const { token } = mintToken(h, ws.id, "manager");

    const res = await h.server.inject({
      method: "PUT",
      url: "/agent/worktrees/default",
      headers: bearer(token),
      payload: { branch_prefix: "clobber", worktree_root: "/mnt/ssd/worktrees" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; branch_prefix: string | null; worktree_root: string | null };
    expect(body.ok).toBe(true);
    expect(body.branch_prefix).toBe("clobber");
    expect(body.worktree_root).toBe("/mnt/ssd/worktrees");

    await teardown(h);
  });

  it("response worktree_root is null when not set", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      spawn_worktree: { kind: "on" },
    });
    seedWorkspaceRoles(h.db, ws.id);
    const { token } = mintToken(h, ws.id, "manager");

    const res = await h.server.inject({
      method: "PUT",
      url: "/agent/worktrees/default",
      headers: bearer(token),
      payload: { branch_prefix: "clobber" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; branch_prefix: string | null; worktree_root: string | null };
    expect(body.ok).toBe(true);
    expect(body.branch_prefix).toBe("clobber");
    expect(body.worktree_root).toBe(null);

    await teardown(h);
  });
});
