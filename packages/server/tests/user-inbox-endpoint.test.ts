// #615 — user inbox panel: GET /notifications?recipient=user + POST /notifications/:id/ack
// Real-path tests via server.inject — no agent tokens needed for these public routes.

import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
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
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import type { SpawnedAgentInfo } from "../src/types.ts";
import type { CreateNotification } from "@clobber/shared";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  notifications: ReturnType<typeof createNotificationStore>;
  agentId: string;
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
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-user-inbox-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);

  const workerRole = roles.findInWorkspace(ws.id, "worker");
  if (workerRole === null) throw new Error("worker role not seeded");
  const agent = agents.create({ workspace_id: ws.id, role_id: workerRole.id });

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
    spawner: () => ({ ...STUB, sessionId: "test-stub", stdin: makeStdin() }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });

  return { server, db, notifications, agentId: agent.id, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

function userNotifReq(body: string): CreateNotification {
  return {
    type: "push",
    category: "durable",
    recipient: { kind: "user" },
    priority: "high",
    payload: { body, tag: { kind: "trigger", attrs: { via: "cron" } } },
    provenance: { source_kind: "push" },
  };
}

function agentNotifReq(agentId: string, body: string): CreateNotification {
  return {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "low",
    payload: { body, tag: { kind: "trigger", attrs: { via: "cron" } } },
    provenance: { source_kind: "trigger" },
  };
}

// ─── GET /notifications?recipient=user ────────────────────────────────────────

describe("GET /notifications?recipient=user — user inbox list", () => {
  it("returns empty array when no user notifications exist", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({ method: "GET", url: "/notifications?recipient=user" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notifications: unknown[] };
      expect(body.notifications).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("returns user notifications with all expected fields", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      h.notifications.create(userNotifReq("hello user"), T);

      const res = await h.server.inject({ method: "GET", url: "/notifications?recipient=user" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        notifications: Array<{
          id: string;
          type: string;
          priority: string;
          state: string;
          payload: { body: string };
          provenance: { source_kind: string };
          created_at: number;
        }>;
      };
      expect(body.notifications).toHaveLength(1);
      const n = body.notifications[0]!;
      expect(n.type).toBe("push");
      expect(n.priority).toBe("high");
      expect(n.state).toBe("pending");
      expect(n.payload.body).toBe("hello user");
      expect(n.provenance.source_kind).toBe("push");
      expect(typeof n.id).toBe("string");
      expect(typeof n.created_at).toBe("number");
    } finally {
      await teardown(h);
    }
  });

  it("response includes full inspector fields — metadata, recipient, delivery_mode, acked_at", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const req: CreateNotification = {
        ...userNotifReq("inspector shape"),
        metadata: { ref: "main", run_id: "42" },
        delivery_mode: "quiet",
      };
      const { notification: created } = h.notifications.create(req, T);

      const res = await h.server.inject({ method: "GET", url: "/notifications?recipient=user" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        notifications: Array<{
          id: string;
          recipient: { kind: string };
          metadata: Record<string, unknown>;
          delivery_mode: string | undefined;
          acked_at: number | undefined;
        }>;
      };
      expect(body.notifications).toHaveLength(1);
      const n = body.notifications[0]!;
      expect(n.id).toBe(created.id);
      // inspector fields all present
      expect(n.recipient).toEqual({ kind: "user" });
      expect(n.metadata).toEqual({ ref: "main", run_id: "42" });
      expect(n.delivery_mode).toBe("quiet");
      // acked_at absent for a pending row (not yet acked)
      expect(n.acked_at).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  it("excludes agent-recipient notifications", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      h.notifications.create(userNotifReq("for-user"), T);
      h.notifications.create(agentNotifReq(h.agentId, "for-agent"), T + 1);

      const res = await h.server.inject({ method: "GET", url: "/notifications?recipient=user" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notifications: Array<{ payload: { body: string } }> };
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0]!.payload.body).toBe("for-user");
    } finally {
      await teardown(h);
    }
  });

  it("excludes acked notifications", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(userNotifReq("acked-already"), T);
      h.notifications.markAcked(n.id, T + 1);

      const res = await h.server.inject({ method: "GET", url: "/notifications?recipient=user" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { notifications: unknown[] };
      expect(body.notifications).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("400 when recipient query param is missing or wrong", async () => {
    const h = buildHarness();
    try {
      const noRecipient = await h.server.inject({ method: "GET", url: "/notifications" });
      expect(noRecipient.statusCode).toBe(400);

      const wrongRecipient = await h.server.inject({
        method: "GET",
        url: "/notifications?recipient=agent",
      });
      expect(wrongRecipient.statusCode).toBe(400);
    } finally {
      await teardown(h);
    }
  });
});

// ─── POST /notifications/:id/ack (user-side, no auth token) ──────────────────

describe("POST /notifications/:id/ack — user inbox ack", () => {
  it("acks a user-recipient notification and returns {ok: true}", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(userNotifReq("ack-me"), T);

      const res = await h.server.inject({
        method: "POST",
        url: `/notifications/${n.id}/ack`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);

      const after = h.notifications.get(n.id)!;
      expect(after.state).toBe("acked");
    } finally {
      await teardown(h);
    }
  });

  it("returns 404 for a nonexistent notification id", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "POST",
        url: "/notifications/does-not-exist/ack",
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await teardown(h);
    }
  });

  it("returns 403 when trying to ack an agent-recipient notification", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(agentNotifReq(h.agentId, "agent-row"), T);

      const res = await h.server.inject({
        method: "POST",
        url: `/notifications/${n.id}/ack`,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await teardown(h);
    }
  });

  it("ack is idempotent — second ack of user notification returns 200", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(userNotifReq("ack-twice"), T);
      h.notifications.markAcked(n.id, T + 1);

      const res = await h.server.inject({
        method: "POST",
        url: `/notifications/${n.id}/ack`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await teardown(h);
    }
  });

  it("acked notification no longer appears in GET list", async () => {
    const h = buildHarness();
    try {
      const T = Date.now();
      const { notification: n } = h.notifications.create(userNotifReq("visible-then-gone"), T);

      const before = await h.server.inject({ method: "GET", url: "/notifications?recipient=user" });
      expect((before.json() as { notifications: unknown[] }).notifications).toHaveLength(1);

      await h.server.inject({ method: "POST", url: `/notifications/${n.id}/ack`, payload: {} });

      const after = await h.server.inject({ method: "GET", url: "/notifications?recipient=user" });
      expect((after.json() as { notifications: unknown[] }).notifications).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });
});
