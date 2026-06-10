import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { deliver, type DeliverDeps } from "../src/notification-dispatch.ts";
import type { AttachSessionFn } from "../src/trigger-attach.ts";
import type { ResumeEndedResult } from "../src/resume-pipeline.ts";
import type { Notification } from "@clobber/shared";

const BODY = "wake-kick: server restarted";
const TAG = { kind: "trigger" as const, attrs: { via: "button" as const } };

function makeNotification(agentId: string): Notification {
  return {
    id: "notif-1",
    type: "trigger",
    category: "transient",
    state: "pending",
    priority: "high",
    recipient: { kind: "agent", agent_id: agentId },
    payload: { body: BODY, tag: TAG },
    provenance: { source_kind: "trigger", source_id: "button" },
    metadata: {},
    created_at: Date.now(),
  };
}

function makeHarness(opts: {
  hasShutdownSession?: boolean;
  resumeResult?: ResumeEndedResult;
  resumeThrows?: Error;
} = {}) {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();

  const repoPath = mkdtempSync(join(tmpdir(), "clobber-dispatch-resume-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "mgr-1" });

  if (opts.hasShutdownSession) {
    sessions.create({
      id: "ended-session-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleRow.id,
      pid: 1234,
      provider_thread_id: "thread-abc",
    });
    sessions.markWasLiveAtShutdown("ended-session-1");
    sessions.markEnded("ended-session-1");
  }

  const resumeCalls: { sessionId: string; prompt: string }[] = [];
  const spawnCalls: Parameters<AttachSessionFn>[0][] = [];

  const defaultResumeResult: ResumeEndedResult = {
    ok: true,
    session_id: "ended-session-1",
    pid: 5678,
  };

  const resumeEndedSession = async (input: { sessionId: string; prompt: string }) => {
    resumeCalls.push(input);
    if (opts.resumeThrows) throw opts.resumeThrows;
    return opts.resumeResult ?? defaultResumeResult;
  };

  const attachSession: AttachSessionFn = async (input) => {
    spawnCalls.push(input);
    sessions.create({
      id: "spawned-session-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleRow.id,
      pid: 9999,
    });
    return { ok: true, agent_id: agent.id, session_id: "spawned-session-1", pid: 9999 };
  };

  const role = roles.get(roleRow.id)!;
  const workspace = workspaces.get(ws.id)!;

  const deps: DeliverDeps = {
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    attachSession,
    resumeEndedSession,
  };

  return { db, deps, agent, ws, role, workspace, resumeCalls, spawnCalls };
}

describe("deliver() — resume-aware no-active-session branch", () => {
  it("agent with was_live_at_shutdown session → resumed (not fresh-spawn)", async () => {
    const { db, deps, agent, resumeCalls, spawnCalls } = makeHarness({ hasShutdownSession: true });

    const outcome = await deliver(deps, makeNotification(agent.id), { kind: "drop" });

    expect(outcome.action).toBe("resumed");
    expect(outcome.sessionId).toBe("ended-session-1");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]!.sessionId).toBe("ended-session-1");
    expect(resumeCalls[0]!.prompt).toBe(BODY);
    expect(spawnCalls).toHaveLength(0);

    db.close();
  });

  it("agent with no shutdown session → fresh-spawn fallback", async () => {
    const { db, deps, agent, resumeCalls, spawnCalls } = makeHarness({ hasShutdownSession: false });

    const outcome = await deliver(deps, makeNotification(agent.id), { kind: "drop" });

    expect(outcome.action).toBe("spawned");
    expect(outcome.sessionId).toBe("spawned-session-1");
    expect(resumeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.prompt).toBe(BODY);

    db.close();
  });

  it("resume fails → falls back to fresh-spawn rather than dropping the trigger", async () => {
    const failResult: ResumeEndedResult = {
      ok: false,
      status: 410,
      error: "runtime provider thread not found",
    };
    const { db, deps, agent, resumeCalls, spawnCalls } = makeHarness({
      hasShutdownSession: true,
      resumeResult: failResult,
    });

    const outcome = await deliver(deps, makeNotification(agent.id), { kind: "drop" });

    expect(outcome.action).toBe("spawned");
    expect(outcome.sessionId).toBe("spawned-session-1");
    expect(resumeCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);

    db.close();
  });

  it("resumeEndedSession throws → falls through to fresh-spawn rather than stranding as errored", async () => {
    const { db, deps, agent, resumeCalls, spawnCalls } = makeHarness({
      hasShutdownSession: true,
      resumeThrows: new Error("transcript repair failed"),
    });

    const outcome = await deliver(deps, makeNotification(agent.id), { kind: "drop" });

    expect(outcome.action).toBe("spawned");
    expect(outcome.sessionId).toBe("spawned-session-1");
    expect(resumeCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);

    db.close();
  });
});

describe("deliver() — resume-tip guard (FIX1 #575)", () => {
  it("stale root (was_live=1) + clean-cycle tip (was_live=0) → fresh-spawn, root NOT resumed", async () => {
    const { db, deps, agent, resumeCalls, spawnCalls } = makeHarness();

    // Seed stale root: ended, was_live_at_shutdown=1 (older timestamps — from 40h ago boot-reap)
    db.prepare(
      `INSERT INTO sessions (id, agent_id, workspace_id, role_id, runtime_provider, pid, started_at, ended_at, was_live_at_shutdown)
       VALUES ('root-session', ?, ?, ?, 'claude', 1001, 1000, 2000, 1)`,
    ).run(agent.id, agent.workspace_id, agent.role_id);

    // Seed clean-cycle tip: ended, was_live_at_shutdown=0 (newer timestamps — agent cycled past the root)
    db.prepare(
      `INSERT INTO sessions (id, agent_id, workspace_id, role_id, runtime_provider, pid, started_at, ended_at, was_live_at_shutdown)
       VALUES ('tip-session', ?, ?, ?, 'claude', 1002, 3000, 4000, 0)`,
    ).run(agent.id, agent.workspace_id, agent.role_id);

    const outcome = await deliver(deps, makeNotification(agent.id), { kind: "drop" });

    expect(outcome.action).toBe("spawned");
    expect(outcome.sessionId).toBe("spawned-session-1");
    expect(resumeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.prompt).toBe(BODY);

    db.close();
  });

  it("was_live session IS the chain tip (no clean cycle) → still resumes", async () => {
    const { db, deps, agent, resumeCalls, spawnCalls } = makeHarness({
      resumeResult: { ok: true, session_id: "tip-root-session", pid: 5678 },
    });

    db.prepare(
      `INSERT INTO sessions (id, agent_id, workspace_id, role_id, runtime_provider, pid, started_at, ended_at, was_live_at_shutdown)
       VALUES ('tip-root-session', ?, ?, ?, 'claude', 1001, 1000, 2000, 1)`,
    ).run(agent.id, agent.workspace_id, agent.role_id);

    const outcome = await deliver(deps, makeNotification(agent.id), { kind: "drop" });

    expect(outcome.action).toBe("resumed");
    expect(outcome.sessionId).toBe("tip-root-session");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]!.sessionId).toBe("tip-root-session");
    expect(spawnCalls).toHaveLength(0);

    db.close();
  });
});
