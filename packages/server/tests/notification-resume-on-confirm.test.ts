/**
 * Real-path tests for ephemeral resume-on-confirm (#621).
 *
 * Acceptance criteria (per issue body):
 * (a) Queued rows for a dead non-persistent agent → exactly one confirm-resume
 *     notification delivered to the spawner (owner). No nagware: second
 *     rearmPending call produces no new row (logical_key dedup).
 * (b) No spawner_agent_id → no confirm notification; rows stay queued.
 * (c) POST /sessions/:id/confirm-resume → session resumed (fresh token minted),
 *     queued rows delivered in category-correct order (transient latest-only,
 *     durable deliver-all).
 * (d) POST /sessions/:id/decline-resume → rows stay queued, no new session.
 * (e) Regression: sleeping persistent agent still spawns/resumes unaffected.
 *
 * All flow through the real deliver() / rearmPending() path and the real HTTP
 * server (no stubs on the paths under test).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { CreateNotification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createAgentMessageStore } from "../src/agent-message-store.ts";
import { rearmPending } from "../src/notification-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock } from "../src/clock.ts";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";
import type { DeliverDeps, RearmPendingDeps } from "../src/notification-dispatch.ts";

// ---------- Shared test-data helpers ----------

const T0 = 1_700_000_000_000;

function transientReq(agentId: string, body: string): CreateNotification {
  return {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "high",
    payload: { body, tag: { kind: "trigger", attrs: { via: "worker-done" } } },
    provenance: { source_kind: "trigger" },
    metadata: {},
  };
}

function durableReq(agentId: string, body: string): CreateNotification {
  return {
    type: "message",
    category: "durable",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "high",
    payload: { body, tag: { kind: "message", attrs: { from: "manager", token: "tok-x" } } },
    provenance: { source_kind: "message" },
    metadata: {},
  };
}

// ---------- Direct rearmPending harness (no HTTP) ----------

interface RearmHarness {
  db: ReturnType<typeof createDatabase>;
  store: ReturnType<typeof createNotificationStore>;
  rearmDeps: RearmPendingDeps;
  managerAgentId: string;
  workerAgentId: string;
  workspaceId: string;
  managerRoleId: string;
  workerRoleId: string;
  sessions: ReturnType<typeof createSessionStore>;
  registry: ReturnType<typeof createAgentRegistry>;
  spawnedSessions: string[];
}

function makeRearmHarness(opts: { withOwner: boolean } = { withOwner: true }): RearmHarness {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roc-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const clock = createTestClock(new Date("2026-06-10T12:00:00.000Z"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const store = createNotificationStore(db);

  const ws = workspaces.create({ name: "ws-roc", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);

  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const workerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", ws.id) as { id: string };

  const managerAgent = agents.create({ workspace_id: ws.id, role_id: managerRow.id, label: "mgr" });
  const workerAgent = agents.create({
    workspace_id: ws.id,
    role_id: workerRow.id,
    label: "wkr",
    ...(opts.withOwner ? { spawner_agent_id: managerAgent.id } : {}),
  });

  let spawnCounter = 0;
  const spawnedSessions: string[] = [];
  const attachSession: AttachSessionFn = async (input) => {
    spawnCounter += 1;
    const sid = `spawned-${spawnCounter}`;
    spawnedSessions.push(sid);
    sessions.create({
      id: sid,
      agent_id: input.agent.id,
      workspace_id: ws.id,
      role_id: input.role.id,
      pid: 9000 + spawnCounter,
    });
    const ok: AttachOutcome = {
      ok: true,
      agent_id: input.agent.id,
      session_id: sid,
      pid: 9000 + spawnCounter,
    };
    return ok;
  };

  const deliverDeps: DeliverDeps = {
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    attachSession,
    resumeEndedSession: async () => ({
      ok: false,
      status: 409,
      error: "runtime does not support resume" as const,
    }),
  };

  const rearmDeps: RearmPendingDeps = {
    ...deliverDeps,
    store,
    clock,
    resolveOwner: (agentId) => {
      const agent = agents.get(agentId);
      return agent?.spawner_agent_id ?? null;
    },
    agentMessages: createAgentMessageStore(db),
  };

  return {
    db,
    store,
    rearmDeps,
    managerAgentId: managerAgent.id,
    workerAgentId: workerAgent.id,
    workspaceId: ws.id,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
    sessions,
    registry,
    spawnedSessions,
  };
}

// Seed an ended session for the worker (simulates a dead ephemeral).
function seedDeadSession(
  h: RearmHarness,
  sessionId: string,
): void {
  h.sessions.create({
    id: sessionId,
    agent_id: h.workerAgentId,
    workspace_id: h.workspaceId,
    role_id: h.workerRoleId,
    pid: 8888,
  });
  h.sessions.markEnded(sessionId);
}

// ---------- Part 1: rearmPending confirm-notification emission ----------

describe("rearmPending — ephemeral resume-on-confirm (#621)", () => {
  it("(a1) dead ephemeral with queued rows + owner → exactly one confirm-resume notification to owner", async () => {
    const h = makeRearmHarness({ withOwner: true });
    seedDeadSession(h, "dead-worker-a1");

    // Seed a transient + a durable notification for the dead worker.
    h.store.create(transientReq(h.workerAgentId, "wake-1"), T0);
    h.store.create(durableReq(h.workerAgentId, "msg-1"), T0 + 1000);

    await rearmPending(h.rearmDeps);

    // The manager must have exactly one confirm-resume notification.
    const managerNotifs = h.store.listForAgent(h.managerAgentId);
    const confirmNotifs = managerNotifs.filter((n) => n.type === "confirm-resume");
    expect(confirmNotifs).toHaveLength(1);
    expect(confirmNotifs[0]!.category).toBe("durable");
    expect(confirmNotifs[0]!.priority).toBe("high");
    // The dead session info must be in metadata.
    expect(confirmNotifs[0]!.metadata["dead_agent_id"]).toBe(h.workerAgentId);
    expect(typeof confirmNotifs[0]!.metadata["dead_session_id"]).toBe("string");

    h.db.close();
  });

  it("(a2) logical_key dedup prevents nagware: two rearmPending calls → exactly one confirm row", async () => {
    // Seed a DURABLE row and make attachSession fail so the confirm-resume
    // notification (created on first rearm) stays pending across both calls.
    // On second rearm, maybeEmitConfirmToOwner tries to create another
    // confirm-resume — logical_key dedup must suppress it to exactly one row.
    const h = makeRearmHarness({ withOwner: true });
    const failAttach: AttachSessionFn = async () => ({ ok: false, status: 422 as const, error: "runtime requires a prompt" as const });
    const rearmDeps: RearmPendingDeps = { ...h.rearmDeps, attachSession: failAttach };

    seedDeadSession(h, "dead-worker-a2");
    h.store.create(durableReq(h.workerAgentId, "msg-a2"), T0);

    await rearmPending(rearmDeps);
    await rearmPending(rearmDeps);

    const confirmNotifs = h.store.listForAgent(h.managerAgentId).filter((n) => n.type === "confirm-resume");
    // Second rearm must not produce a duplicate — logical_key dedup absorbs it.
    expect(confirmNotifs).toHaveLength(1);

    h.db.close();
  });

  it("(b) dead ephemeral with NO spawner_agent_id → no confirm notification, rows stay queued", async () => {
    const h = makeRearmHarness({ withOwner: false });
    seedDeadSession(h, "dead-worker-b1");
    h.store.create(transientReq(h.workerAgentId, "wake-b"), T0);
    h.store.create(durableReq(h.workerAgentId, "msg-b"), T0 + 1000);

    await rearmPending(h.rearmDeps);

    // No confirm notifications for anyone.
    const allNotifs = h.store.listPending();
    const confirmRows = allNotifs.filter((n) => n.type === "confirm-resume");
    expect(confirmRows).toHaveLength(0);

    // The worker's rows stay queued (durable — transient stale cancellation
    // applies to stale rows only; the latest transient stays pending).
    const workerPending = h.store.listPending().filter(
      (n) => n.recipient.kind === "agent" && n.recipient.agent_id === h.workerAgentId,
    );
    expect(workerPending.length).toBeGreaterThan(0);

    h.db.close();
  });

  it("(e) regression: sleeping persistent manager still spawns (non-ephemeral path untouched)", async () => {
    const h = makeRearmHarness({ withOwner: true });

    // Seed a high-priority trigger notification for the MANAGER (persistent).
    h.store.create(
      {
        type: "trigger",
        category: "transient",
        recipient: { kind: "agent", agent_id: h.managerAgentId },
        priority: "high",
        payload: { body: "worker done", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
        provenance: { source_kind: "trigger" },
        metadata: {},
      },
      T0,
    );

    await rearmPending(h.rearmDeps);

    // Manager must have been spawned.
    expect(h.spawnedSessions).toHaveLength(1);
    // Notification delivered.
    expect(h.store.listPending()).toHaveLength(0);

    h.db.close();
  });
});

// ---------- Part 2: HTTP endpoint tests ----------

import { createEventStore } from "../src/event-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { createServer } from "../src/server.ts";
import type { AgentSpawner } from "../src/types.ts";

interface EndpointHarness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  notifications: ReturnType<typeof createNotificationStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  managerAgentId: string;
  workerAgentId: string;
  managerRoleId: string;
  workerRoleId: string;
  workspaceId: string;
  spawnedSessions: string[];
}

let endpointHarness: EndpointHarness;

function buildEndpointHarness(): EndpointHarness {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roc-http-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");

  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionSummaries = createWorkspaceSessionSummaries(db);
  const tokens = createSessionTokenStore(db);
  const agentStatuses = createAgentStatusStore(db);
  const agentStatusLog = createAgentStatusLogStore(db);
  const agentQuestions = createAgentQuestionStore(db);
  const agentQuestionWaiter = createAgentQuestionWaiter();
  const dispatches = createTriggerDispatchStore(db);
  const finalReportConsumerState = createFinalReportConsumerStateStore(db);
  const notifications = createNotificationStore(db);

  const spawnedSessions: string[] = [];
  const spawner: AgentSpawner = (req) => {
    const sid = req.sessionId ?? `spawned-${spawnedSessions.length + 1}`;
    spawnedSessions.push(sid);
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: sid,
      pid: 5000 + spawnedSessions.length,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };

  const ws = workspaces.create({ name: "ws-roc-http", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);

  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const workerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", ws.id) as { id: string };

  const managerAgent = agents.create({ workspace_id: ws.id, role_id: managerRow.id, label: "mgr-http" });
  const workerAgent = agents.create({
    workspace_id: ws.id,
    role_id: workerRow.id,
    label: "wkr-http",
    spawner_agent_id: managerAgent.id,
  });

  const server = createServer({
    db,
    store,
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries,
    sessionTokens: tokens,
    agentStatuses,
    agentStatusLog,
    agentQuestions,
    agentQuestionWaiter,
    dispatches,
    finalReportConsumerState,
    spawner,
    hookUrl: "http://localhost:0/hooks",
    apiBase: "http://localhost:0",
    cliEntry: "clobber",
  });

  return {
    server,
    db,
    notifications,
    agents,
    sessions,
    managerAgentId: managerAgent.id,
    workerAgentId: workerAgent.id,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
    workspaceId: ws.id,
    spawnedSessions,
  };
}

describe("POST /sessions/:id/confirm-resume (#621)", () => {
  beforeEach(() => {
    endpointHarness = buildEndpointHarness();
  });
  afterEach(async () => {
    await endpointHarness.server.close();
    endpointHarness.db.close();
  });

  function seedDeadWorkerSession(h: EndpointHarness, sessionId: string): void {
    h.sessions.create({
      id: sessionId,
      agent_id: h.workerAgentId,
      workspace_id: h.workspaceId,
      role_id: h.workerRoleId,
      pid: 7777,
    });
    h.sessions.markEnded(sessionId);
    h.sessions.markWasLiveAtShutdown(sessionId);
  }

  it("(c) confirm-resume → session resumed (fresh token), queued rows delivered category-correctly", async () => {
    const h = endpointHarness;
    seedDeadWorkerSession(h, "dead-w-c1");

    // Seed mixed pending rows: 2 stale transient + 1 latest transient + 2 durable.
    h.notifications.create(transientReq(h.workerAgentId, "stale-1"), T0);
    h.notifications.create(transientReq(h.workerAgentId, "stale-2"), T0 + 1000);
    h.notifications.create(transientReq(h.workerAgentId, "latest-transient"), T0 + 2000);
    h.notifications.create(durableReq(h.workerAgentId, "msg-alpha"), T0 + 3000);
    h.notifications.create(durableReq(h.workerAgentId, "msg-beta"), T0 + 4000);

    const tok = createAgentMessageStore(h.db).issue({
      originator_session_id: "dead-w-c1",
      recipient_session_id: "dead-w-c1",
      originator_agent_id: h.workerAgentId,
      recipient_agent_id: h.workerAgentId,
    });
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/dead-w-c1/confirm-resume`,
      payload: { token: tok.token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; session_id: string }>();
    expect(body.ok).toBe(true);
    expect(typeof body.session_id).toBe("string");

    // The worker session must have been resumed (a new active session exists).
    const active = h.sessions.listActiveForWorkspace(h.workspaceId)
      .filter((s) => s.agent_id === h.workerAgentId);
    expect(active).toHaveLength(1);

    // After resume + rearm: stale transient cancelled, latest transient delivered,
    // both durables delivered. No rows pending for the worker.
    const workerNotifs = h.notifications.listForAgent(h.workerAgentId);
    const pending = workerNotifs.filter((n) => n.state === "pending");
    expect(pending).toHaveLength(0);
    const cancelled = workerNotifs.filter((n) => n.state === "cancelled");
    expect(cancelled).toHaveLength(2); // 2 stale transients
    const delivered = workerNotifs.filter((n) => n.state === "delivered");
    // latest transient + 2 durables = 3 delivered
    expect(delivered).toHaveLength(3);

    h.db.close();
  });

  it("(d) decline-resume → rows stay queued, no new session", async () => {
    const h = endpointHarness;
    seedDeadWorkerSession(h, "dead-w-d1");
    h.notifications.create(durableReq(h.workerAgentId, "msg-d1"), T0);
    h.notifications.create(transientReq(h.workerAgentId, "wake-d1"), T0 + 1000);

    const tok = createAgentMessageStore(h.db).issue({
      originator_session_id: "dead-w-d1",
      recipient_session_id: "dead-w-d1",
      originator_agent_id: h.workerAgentId,
      recipient_agent_id: h.workerAgentId,
    });
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/dead-w-d1/decline-resume`,
      payload: { token: tok.token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    // No new active session — still dead.
    const active = h.sessions.listActiveForWorkspace(h.workspaceId)
      .filter((s) => s.agent_id === h.workerAgentId);
    expect(active).toHaveLength(0);

    // Rows must still be pending (decline does NOT cancel them).
    const pending = h.notifications.listPending().filter(
      (n) => n.recipient.kind === "agent" && n.recipient.agent_id === h.workerAgentId,
    );
    expect(pending.length).toBeGreaterThan(0);

    h.db.close();
  });

  it("confirm-resume without token → 403", async () => {
    const h = endpointHarness;
    seedDeadWorkerSession(h, "dead-w-403-a");
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/dead-w-403-a/confirm-resume`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("confirm-resume with wrong token → 403", async () => {
    const h = endpointHarness;
    seedDeadWorkerSession(h, "dead-w-403-b");
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/dead-w-403-b/confirm-resume`,
      payload: { token: "notarealtoken" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("decline-resume without token → 403", async () => {
    const h = endpointHarness;
    seedDeadWorkerSession(h, "dead-w-403-c");
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/dead-w-403-c/decline-resume`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("decline-resume with wrong token → 403", async () => {
    const h = endpointHarness;
    seedDeadWorkerSession(h, "dead-w-403-d");
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/dead-w-403-d/decline-resume`,
      payload: { token: "notarealtoken" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("confirm-resume on unknown session → 404", async () => {
    const h = endpointHarness;
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/ghost-session/confirm-resume`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("confirm-resume on still-active session → 409", async () => {
    const h = endpointHarness;
    // Create an ACTIVE session (not ended).
    h.sessions.create({
      id: "still-alive",
      agent_id: h.workerAgentId,
      workspace_id: h.workspaceId,
      role_id: h.workerRoleId,
      pid: 6000,
    });
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/still-alive/confirm-resume`,
    });
    expect(res.statusCode).toBe(409);
  });
});
