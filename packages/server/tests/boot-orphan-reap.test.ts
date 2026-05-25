import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { reapOrphanedSessions } from "../src/boot-reap.ts";
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
    pid: 9000,
  });
  if (opts.preEnded === true) h.sessions.markEnded(sessionId);
  return { workspaceId: ws.id, roleId: role.id, agentId: agent.id, sessionId };
}

describe("reapOrphanedSessions (boot-time)", () => {
  it("ends every active session left over from a previous process", async () => {
    const h = buildHarness();
    const a = seed(h, { persistent: false });
    const b = seed(h, { persistent: true });

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
    const ephemeral = seed(h, { persistent: false });
    const persistent = seed(h, { persistent: true });

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
    const claude = seed(h, { persistent: false });
    const codex = seed(h, {
      persistent: true,
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
    const done = seed(h, { persistent: false, preEnded: true });

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
    const done = seed(h, { persistent: false, preEnded: true });
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
      runtimeProvider: "codex",
      providerThreadId: "thread-1",
    });
    const claude = seed(h, { persistent: true });

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
    const a = seed(h, { persistent: false });
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
    const h = buildHarness();

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
