// #613 — agent self-inbox: GET /agent/notifications + POST /agent/notifications/:id/ack
// Real-path tests via server.inject with agent tokens.

import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { composeUnackedNotifications } from "../src/notification-inbox.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import type { SpawnedAgentInfo } from "../src/types.ts";
import type { CreateNotification } from "@clobber/shared";

interface AgentSession {
  readonly agentId: string;
  readonly sessionId: string;
  readonly token: string;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  notifications: ReturnType<typeof createNotificationStore>;
  agentA: AgentSession;
  agentB: AgentSession;
  repoPath: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

const STUB: SpawnedAgentInfo = {
  sessionId: "stub",
  pid: 9000,
  exited: new Promise<number | null>(() => {}),
  stdin: new PassThrough(),
  kill: () => {},
};

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const notifications = createNotificationStore(db);
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-self-inbox-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);

  const workerRole = roles.findInWorkspace(ws.id, "worker");
  if (workerRole === null) throw new Error("worker role not seeded");
  const workerRoleId = workerRole.id;

  function provisionAgent(): AgentSession {
    const agent = agents.create({ workspace_id: ws.id, role_id: workerRoleId });
    const sessionId = randomUUID();
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: workerRoleId,
      pid: 1,
    });
    const token = tokens.mint(sessionId);
    return { agentId: agent.id, sessionId, token };
  }

  const agentA = provisionAgent();
  const agentB = provisionAgent();

  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => ({ ...STUB, sessionId: randomUUID(), stdin: makeStdin() }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });

  return { server, db, notifications, agentA, agentB, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function agentNotifReq(agentId: string, body: string): CreateNotification {
  return {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "high",
    payload: { body, tag: { kind: "trigger", attrs: { via: "cron" } } },
    provenance: { source_kind: "trigger", emitter_agent_id: agentId },
  };
}

// ─── GET /agent/notifications ─────────────────────────────────────────────────

describe("GET /agent/notifications — agent self-inbox list", () => {
  it("401 when no token provided", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({ method: "GET", url: "/agent/notifications" });
      expect(res.statusCode).toBe(401);
    } finally {
      await teardown(h);
    }
  });

  it("returns only own unacked notifications (not another agent's)", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      h.notifications.create(agentNotifReq(h.agentA.agentId, "for-a"), T);
      h.notifications.create(agentNotifReq(h.agentB.agentId, "for-b"), T + 1);

      const res = await h.server.inject({
        method: "GET",
        url: "/agent/notifications",
        headers: bearer(h.agentA.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notifications: { payload: { body: string } }[] };
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0]!.payload.body).toBe("for-a");
    } finally {
      await teardown(h);
    }
  });

  it("returns empty array when agent has no unacked notifications", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "GET",
        url: "/agent/notifications",
        headers: bearer(h.agentA.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notifications: unknown[] };
      expect(body.notifications).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("acked notifications are excluded from list", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(agentNotifReq(h.agentA.agentId, "already-done"), T);
      h.notifications.markAcked(n.id, T + 1);

      const res = await h.server.inject({
        method: "GET",
        url: "/agent/notifications",
        headers: bearer(h.agentA.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notifications: unknown[] };
      expect(body.notifications).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("quiet-mode rows are excluded from list (delivered side-channel via hooks drain)", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const quietReq = { ...agentNotifReq(h.agentA.agentId, "quiet-row"), delivery_mode: "quiet" as const };
      h.notifications.create(quietReq, T);
      h.notifications.create(agentNotifReq(h.agentA.agentId, "normal-row"), T + 1);

      const res = await h.server.inject({
        method: "GET",
        url: "/agent/notifications",
        headers: bearer(h.agentA.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notifications: { payload: { body: string } }[] };
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0]!.payload.body).toBe("normal-row");
    } finally {
      await teardown(h);
    }
  });
});

// ─── POST /agent/notifications/:id/ack ────────────────────────────────────────

describe("POST /agent/notifications/:id/ack — agent self-inbox ack", () => {
  it("401 when no token provided", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/notifications/any-id/ack",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await teardown(h);
    }
  });

  it("acks own row successfully", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(agentNotifReq(h.agentA.agentId, "ack-me"), T);

      const res = await h.server.inject({
        method: "POST",
        url: `/agent/notifications/${n.id}/ack`,
        headers: bearer(h.agentA.token),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean };
      expect(body.ok).toBe(true);

      const updated = h.notifications.get(n.id)!;
      expect(updated.state).toBe("acked");
    } finally {
      await teardown(h);
    }
  });

  it("403 when agent tries to ack another agent's row", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(agentNotifReq(h.agentB.agentId, "belongs-to-b"), T);

      const res = await h.server.inject({
        method: "POST",
        url: `/agent/notifications/${n.id}/ack`,
        headers: bearer(h.agentA.token),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await teardown(h);
    }
  });

  it("404 when notification id does not exist", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/notifications/nonexistent-id/ack",
        headers: bearer(h.agentA.token),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await teardown(h);
    }
  });

  it("ack is idempotent — second ack returns 200", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(agentNotifReq(h.agentA.agentId, "ack-twice"), T);
      h.notifications.markAcked(n.id, T + 1);

      const res = await h.server.inject({
        method: "POST",
        url: `/agent/notifications/${n.id}/ack`,
        headers: bearer(h.agentA.token),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await teardown(h);
    }
  });
});

// ─── end-to-end: ack → drops from boot re-dump ────────────────────────────────

describe("acked row drops from composeUnackedNotifications re-dump (loop-closer)", () => {
  it("acking via the route removes the row from the boot re-dump", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(agentNotifReq(h.agentA.agentId, "close-the-loop"), T);

      const before = composeUnackedNotifications(h.agentA.agentId, h.notifications);
      expect(before).toContain("close-the-loop");

      await h.server.inject({
        method: "POST",
        url: `/agent/notifications/${n.id}/ack`,
        headers: bearer(h.agentA.token),
        payload: {},
      });

      const after = composeUnackedNotifications(h.agentA.agentId, h.notifications);
      expect(after).not.toContain("close-the-loop");
    } finally {
      await teardown(h);
    }
  });
});
