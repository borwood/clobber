import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { deliver, type DeliverDeps } from "../src/notification-dispatch.ts";
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
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createTestClock } from "../src/clock.ts";
import { createServer } from "../src/server.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { Notification } from "@clobber/shared";
import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// Pre-change notifications DDL: all columns except delivery_mode.
// Simulates a clobber.db created before this PR.
const PRE_CHANGE_NOTIFICATIONS = `
  CREATE TABLE notifications (
    id                 TEXT    PRIMARY KEY,
    type               TEXT    NOT NULL,
    recipient_kind     TEXT    NOT NULL,
    recipient_agent_id TEXT,
    priority           TEXT    NOT NULL,
    payload_json       TEXT    NOT NULL,
    provenance_json    TEXT    NOT NULL,
    metadata_json      TEXT    NOT NULL,
    state              TEXT    NOT NULL,
    created_at         INTEGER NOT NULL,
    delivered_at       INTEGER,
    acked_at           INTEGER,
    logical_key        TEXT
  )
`;

// Insert a quiet notification directly into the DB (bypasses store.create() for
// the failing-test phase; after implementation the store API supports delivery_mode).
function insertQuietRow(db: ReturnType<typeof createDatabase>, agentId: string, body: string): string {
  const id = randomUUID();
  const stmt = db.prepare(
    `INSERT INTO notifications
       (id, type, recipient_kind, recipient_agent_id, priority,
        payload_json, provenance_json, metadata_json, state, created_at,
        delivered_at, acked_at, logical_key, delivery_mode)
     VALUES (?, 'alert', 'agent', ?, 'high', ?, '{"source_kind":"test"}', '{}',
             'pending', ?, NULL, NULL, NULL, 'quiet')`,
  );
  stmt.run(id, agentId, JSON.stringify({ body, tag: { kind: "trigger" } }), Date.now());
  return id;
}

// ─── AC6 ─────────────────────────────────────────────────────────────────────

describe("AC6 — old-shape-DB boot: delivery_mode migration", () => {
  it("createDatabase on a pre-change DB (no delivery_mode column) adds the column via migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-ac6-"));
    const dbPath = join(dir, "clobber.db");

    const seed = new Database(dbPath);
    seed.exec(PRE_CHANGE_NOTIFICATIONS);
    seed.close();

    expect(() => createDatabase(dbPath)).not.toThrow();

    const db = new Database(dbPath);
    const cols = (
      db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).toContain("delivery_mode");
    db.close();
    rmSync(dir, { recursive: true });
  });
});

// ─── AC4 ─────────────────────────────────────────────────────────────────────

interface QuietDeliverHarness {
  db: ReturnType<typeof createDatabase>;
  store: ReturnType<typeof createNotificationStore>;
  deps: DeliverDeps;
  agentId: string;
  spawnCalls: number;
  resumeCalls: number;
}

function makeDeliverHarness(): QuietDeliverHarness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const store = createNotificationStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: "/tmp/test-repo" });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "mgr-1" });

  let spawnCalls = 0;
  let resumeCalls = 0;

  const deps: DeliverDeps = {
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    attachSession: async () => {
      spawnCalls++;
      return { ok: true, agent_id: agent.id, session_id: "spawned-1", pid: 0 };
    },
    resumeEndedSession: async () => {
      resumeCalls++;
      return { ok: false, status: 409, error: "runtime does not support resume" as const };
    },
  };

  return {
    db,
    store,
    deps,
    agentId: agent.id,
    get spawnCalls() { return spawnCalls; },
    get resumeCalls() { return resumeCalls; },
  };
}

describe("AC4 — quiet never wakes: deliver() with no active session", () => {
  it("quiet notification with no active session: stays pending, zero spawn calls", async () => {
    const h = makeDeliverHarness();
    const notifId = insertQuietRow(h.db, h.agentId, "hello quiet");

    const pending = h.store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(notifId);

    const n = pending[0] as Notification;
    const outcome = await deliver(h.deps, n, { kind: "drop" });

    // Quiet: no spawn, no resume, row stays pending
    expect(h.spawnCalls).toBe(0);
    expect(h.resumeCalls).toBe(0);
    expect(outcome.action).toBe("queued");

    const stillPending = h.store.listPending();
    expect(stillPending).toHaveLength(1);
    h.db.close();
  });

  it("quiet notification with active session: no stdin write, row stays pending", async () => {
    const h = makeDeliverHarness();
    const notifId = insertQuietRow(h.db, h.agentId, "quiet-live");

    // Register a live session
    const sessionId = "live-sess-1";
    const stdin = new PassThrough();
    stdin.resume();
    const writes: Buffer[] = [];
    stdin.on("data", (c: Buffer) => writes.push(c));
    h.deps.sessions.create({
      id: sessionId,
      agent_id: h.agentId,
      workspace_id: (h.deps.agents.get(h.agentId)!).workspace_id,
      role_id: (h.deps.agents.get(h.agentId)!).role_id,
      pid: 5000,
    });
    h.deps.registry.register(sessionId, stdin, () => {}, false);

    const n = h.store.listPending()[0] as Notification;
    const outcome = await deliver(h.deps, n, { kind: "drop" });

    // Quiet: no stdin write even with active live session
    expect(writes).toHaveLength(0);
    expect(outcome.action).toBe("queued");
    expect(h.store.listPending()).toHaveLength(1);
    expect(h.store.listPending()[0]!.id).toBe(notifId);
    h.db.close();
  });
});

// ─── AC1 ─────────────────────────────────────────────────────────────────────

interface ServerHarness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  agentId: string;
  sessionId: string;
}

let repoPath: string;
beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-ac1-"));
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function buildServerHarness(): Promise<ServerHarness> {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);

  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId ?? randomUUID(),
      pid: 9999,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };

  const server = createServer({
    db,
    store: (await import("../src/event-store.ts")).createEventStore(db),
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: "worker", persistent: false });
  workspaceRoles.setCeiling(ws.id, role.id, 5);

  const spawnRes = await server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
  });
  expect(spawnRes.statusCode).toBe(200);
  const body = spawnRes.json() as { session_id: string; agent_id: string };

  return { server, db, agentId: body.agent_id, sessionId: body.session_id };
}

describe("AC1 — drain-once: quiet row drained exactly once across both hook events", () => {
  it("UserPromptSubmit first: drains once, PostToolUse second: not re-drained", async () => {
    const h = await buildServerHarness();
    const notifBody = "you have a quiet message";
    insertQuietRow(h.db, h.agentId, notifBody);

    const uprRes = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: h.sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "hello",
        transcript_path: "/tmp/t.jsonl",
        cwd: repoPath,
        permission_mode: "bypassPermissions",
      },
    });
    expect(uprRes.statusCode).toBe(200);
    const uprBody = uprRes.json() as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    // AC1: quiet row must appear in additionalContext
    expect(uprBody.hookSpecificOutput?.additionalContext).toContain(notifBody);

    // Row must be delivered now
    const store = createNotificationStore(h.db);
    const pendingAfterUpr = store.listPending();
    expect(pendingAfterUpr).toHaveLength(0);

    // PostToolUse next: NOT re-delivered (drain is empty, response is {continue:true})
    const ptuRes = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: h.sessionId,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_x",
        tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
        transcript_path: "/tmp/t.jsonl",
        cwd: repoPath,
        permission_mode: "bypassPermissions",
      },
    });
    expect(ptuRes.statusCode).toBe(200);
    const ptuBody = ptuRes.json() as {
      continue?: boolean;
      hookSpecificOutput?: { additionalContext: string };
    };
    // Drain was empty → no quiet body in response
    expect((ptuBody.hookSpecificOutput?.additionalContext ?? "")).not.toContain(notifBody);

    await h.server.close();
    h.db.close();
  });

  it("PostToolUse first: drains once, UserPromptSubmit second: not re-drained", async () => {
    const h = await buildServerHarness();
    const notifBody = "quiet ptu-first message";
    insertQuietRow(h.db, h.agentId, notifBody);

    const ptuRes = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: h.sessionId,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_use_id: "toolu_y",
        tool_response: { stdout: "hi", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
        transcript_path: "/tmp/t.jsonl",
        cwd: repoPath,
        permission_mode: "bypassPermissions",
      },
    });
    expect(ptuRes.statusCode).toBe(200);
    const ptuBody = ptuRes.json() as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    expect(ptuBody.hookSpecificOutput?.additionalContext).toContain(notifBody);

    const store = createNotificationStore(h.db);
    expect(store.listPending()).toHaveLength(0);

    const uprRes = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: h.sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "hello",
        transcript_path: "/tmp/t.jsonl",
        cwd: repoPath,
        permission_mode: "bypassPermissions",
      },
    });
    const uprBody = uprRes.json() as { hookSpecificOutput?: { additionalContext: string } };
    expect((uprBody.hookSpecificOutput?.additionalContext ?? "")).not.toContain(notifBody);

    await h.server.close();
    h.db.close();
  });
});
