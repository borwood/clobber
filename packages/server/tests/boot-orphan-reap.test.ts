import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { reapOrphanedSessions } from "../src/boot-reap.ts";
import { endSession } from "../src/session-lifecycle.ts";
import { codexRuntimeProvider } from "@clobber/runtime";

interface Harness {
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  sessionTokens: ReturnType<typeof createSessionTokenStore>;
  agentQuestions: ReturnType<typeof createAgentQuestionStore>;
  agentQuestionWaiter: ReturnType<typeof createAgentQuestionWaiter>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  return {
    db,
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
    sessionTokens: createSessionTokenStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
  };
}

interface SeedOpts {
  readonly persistent: boolean;
  readonly pid: number;
  readonly preEnded?: boolean;
  readonly runtimeProvider?: string;
  readonly providerThreadId?: string;
}

function seed(h: Harness, opts: SeedOpts) {
  const ws = h.workspaces.create({ name: `ws-${randomUUID()}`, repo_path: "/r" });
  const role = h.roles.create({
    name: `role-${randomUUID()}`,
    persistent: opts.persistent,
  });
  const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    ...(opts.runtimeProvider === undefined ? {} : { runtime_provider: opts.runtimeProvider }),
    ...(opts.providerThreadId === undefined
      ? {}
      : { provider_thread_id: opts.providerThreadId }),
    pid: opts.pid,
  });
  if (opts.preEnded === true) h.sessions.markEnded(sessionId);
  return { workspaceId: ws.id, roleId: role.id, agentId: agent.id, sessionId };
}

// Spawn a process, kill it, and return its (now-dead) pid.
async function spawnAndReapPid(): Promise<number> {
  const child = spawn("sleep", ["100"]);
  await new Promise<void>((resolve) => child.on("spawn", resolve));
  const pid = child.pid!;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("close", resolve));
  return pid;
}

describe("reapOrphanedSessions (boot-time)", () => {
  it("ends every active session left over from a previous process", async () => {
    const h = buildHarness();
    const a = seed(h, { persistent: false, pid: 9000 });
    const b = seed(h, { persistent: true, pid: 9000 });

    expect(h.sessions.get(a.sessionId)!.ended_at).toBeUndefined();
    expect(h.sessions.get(b.sessionId)!.ended_at).toBeUndefined();

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    expect(typeof h.sessions.get(a.sessionId)!.ended_at).toBe("number");
    expect(typeof h.sessions.get(b.sessionId)!.ended_at).toBe("number");
    h.db.close();
  });

  it("preserves agents (ephemeral and persistent) so resume can reattach", async () => {
    const h = buildHarness();
    const ephemeral = seed(h, { persistent: false, pid: 9000 });
    const persistent = seed(h, { persistent: true, pid: 9000 });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    // The agent row survives end so `clobber resume` can reattach to the same
    // worktree/desk/identity — for non-persistent workers too.
    expect(h.agents.get(ephemeral.agentId)).not.toBeNull();
    expect(h.agents.get(persistent.agentId)).not.toBeNull();
    h.db.close();
  });

  it("flags every active session was-live-at-shutdown (reaped or skipped)", async () => {
    const h = buildHarness();
    const claude = seed(h, { persistent: false, pid: 9000 });
    const codex = seed(h, {
      persistent: true,
      pid: 9000,
      runtimeProvider: "codex",
      providerThreadId: "thread-1",
    });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
      runtimeProvider: codexRuntimeProvider,
    });

    // Reaped claude row: ended + flagged.
    expect(typeof h.sessions.get(claude.sessionId)!.ended_at).toBe("number");
    expect(h.sessions.get(claude.sessionId)!.was_live_at_shutdown).toBe(true);
    // Skipped codex row: still active + flagged.
    expect(h.sessions.get(codex.sessionId)!.ended_at).toBeUndefined();
    expect(h.sessions.get(codex.sessionId)!.was_live_at_shutdown).toBe(true);
    h.db.close();
  });

  it("does not flag sessions that were already ended before boot", async () => {
    const h = buildHarness();
    const done = seed(h, { persistent: false, pid: 9000, preEnded: true });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    expect(h.sessions.get(done.sessionId)!.was_live_at_shutdown).toBeUndefined();
    h.db.close();
  });

  it("does not touch sessions that were already ended", async () => {
    const h = buildHarness();
    const done = seed(h, { persistent: false, pid: 9000, preEnded: true });
    const endedAt = h.sessions.get(done.sessionId)!.ended_at;
    expect(typeof endedAt).toBe("number");

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    expect(h.sessions.get(done.sessionId)!.ended_at).toBe(endedAt!);
    h.db.close();
  });

  it("preserves active sessions for the selected turn-lifetime provider", async () => {
    const h = buildHarness();
    const codex = seed(h, {
      persistent: true,
      pid: 9000,
      runtimeProvider: "codex",
      providerThreadId: "thread-1",
    });
    const claude = seed(h, { persistent: true, pid: 9000 });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
      runtimeProvider: codexRuntimeProvider,
    });

    expect(h.sessions.get(codex.sessionId)!.ended_at).toBeUndefined();
    expect(h.sessions.get(codex.sessionId)!.provider_thread_id).toBe("thread-1");
    expect(typeof h.sessions.get(claude.sessionId)!.ended_at).toBe("number");
    h.db.close();
  });

  it("frees ceiling capacity by zeroing countActive across the board", async () => {
    const h = buildHarness();
    const a = seed(h, { persistent: false, pid: 9000 });
    expect(h.sessions.countActive(a.workspaceId, a.roleId)).toBe(1);

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    expect(h.sessions.countActive(a.workspaceId, a.roleId)).toBe(0);
    h.db.close();
  });

  it("is a no-op when there are no active sessions", async () => {
    const h = buildHarness(); // no seed needed

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    h.db.close();
  });
});

describe("reapOrphanedSessions — liveness gate (#466)", () => {
  it("spares an active session whose child process is still alive", async () => {
    const h = buildHarness();
    const child = spawn("sleep", ["100"]);
    await new Promise<void>((resolve) => child.on("spawn", resolve));
    const livePid = child.pid!;

    const a = seed(h, { persistent: false, pid: livePid });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    // Live child — row must survive
    expect(h.sessions.get(a.sessionId)!.ended_at).toBeUndefined();

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("close", resolve));
    h.db.close();
  });

  it("reaps an active session whose child process is dead (ESRCH)", async () => {
    const h = buildHarness();
    const deadPid = await spawnAndReapPid();

    const a = seed(h, { persistent: false, pid: deadPid });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    // Dead child — row must be ended
    expect(typeof h.sessions.get(a.sessionId)!.ended_at).toBe("number");
    h.db.close();
  });

  it("does not flag a live-process session was-live-at-shutdown", async () => {
    const h = buildHarness();
    const child = spawn("sleep", ["100"]);
    await new Promise<void>((resolve) => child.on("spawn", resolve));
    const livePid = child.pid!;

    const a = seed(h, { persistent: false, pid: livePid });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    // A running session is not a resume candidate — must not be flagged
    expect(h.sessions.get(a.sessionId)!.was_live_at_shutdown).toBeUndefined();

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("close", resolve));
    h.db.close();
  });

  it("flags a reaped dead-process session was-live-at-shutdown", async () => {
    const h = buildHarness();
    const deadPid = await spawnAndReapPid();

    const a = seed(h, { persistent: false, pid: deadPid });

    reapOrphanedSessions({
      sessions: h.sessions,
      agents: h.agents,
      roles: h.roles,
      sessionTokens: h.sessionTokens,
      agentQuestions: h.agentQuestions,
      agentQuestionWaiter: h.agentQuestionWaiter,
    });

    expect(h.sessions.get(a.sessionId)!.was_live_at_shutdown).toBe(true);
    h.db.close();
  });
});

describe("boot — killed agent durability (#433)", () => {
  it("a killed agent remains ended after re-init and boot reconciliation", async () => {
    const h = buildHarness();

    const child = spawn("sleep", ["100"]);
    await new Promise<void>((resolve) => child.on("spawn", resolve));
    const pid = child.pid!;

    const a = seed(h, { persistent: true, pid });

    // Simulate terminateSession: kill child, mark session ended in DB
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("close", resolve));
    endSession(a.sessionId, h);

    expect(typeof h.sessions.get(a.sessionId)!.ended_at).toBe("number");

    // Simulate restart: re-create all store instances from the same DB
    const restarted = {
      sessions: createSessionStore(h.db),
      agents: createAgentStore(h.db),
      roles: createRoleStore(h.db),
      sessionTokens: createSessionTokenStore(h.db),
      agentQuestions: createAgentQuestionStore(h.db),
      agentQuestionWaiter: createAgentQuestionWaiter(),
    };

    reapOrphanedSessions(restarted);

    // Killed agent must NOT be in the active set after restart
    const active = restarted.sessions.listActive();
    expect(active.some((s) => s.id === a.sessionId)).toBe(false);
    expect(typeof restarted.sessions.get(a.sessionId)!.ended_at).toBe("number");

    h.db.close();
  });
});
