/**
 * Real-path integration tests for #638: reply token is session-scoped → route to
 * originator agent's tip, authorise by agent identity (not session identity).
 *
 * AC1  Reply lands on originator's tip AFTER originator cycled (wake-or-queue, not 410).
 * AC2  Reply succeeds AFTER RECIPIENT cycled (agent-equality authz).
 * AC3  Different agent rejected; single-use redemption unchanged (regression).
 * AC4  Failed/incomplete delivery does NOT burn the token (the reorder).
 * AC5  Route returns outcome.action; `replied_at` still present on success.
 */

import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import type { AgentSpawner } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

interface StubAgent {
  readonly sessionId: string;
  readonly writes: string[];
}

interface SpawnControl {
  readonly spawner: AgentSpawner;
  readonly agents: StubAgent[];
}

function controlledSpawner(): SpawnControl {
  const agents: StubAgent[] = [];
  const spawner: AgentSpawner = (req) => {
    if (req.sessionId === undefined) throw new Error("test stub expects sessionId");
    const sessionId = req.sessionId;
    const stdin = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    agents.push({ sessionId, writes });
    return {
      sessionId,
      pid: 4000 + agents.length,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };
  return { spawner, agents };
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  control: SpawnControl;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const control = controlledSpawner();
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
    spawner: control.spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, sessions, tokens, control };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPaths: string[] = [];

beforeEach(() => {
  repoPaths = [];
});

afterEach(() => {
  for (const p of repoPaths) rmSync(p, { recursive: true, force: true });
});

interface Spawned {
  agentId: string;
  sessionId: string;
  token: string;
}

function makeWorkspace(h: Harness): string {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-reply-tip-"));
  repoPaths.push(repoPath);
  const ws = h.workspaces.create({ name: `ws-${Math.random()}`, repo_path: repoPath });
  seedWorkspaceRoles(h.db, ws.id);
  return ws.id;
}

async function spawn(
  h: Harness,
  workspaceId: string,
  roleName: "manager" | "worker",
  label: string,
): Promise<Spawned> {
  const role = h.roles.findInWorkspace(workspaceId, roleName);
  if (role === null) throw new Error(`role ${roleName} not seeded`);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: workspaceId, role_id: role.id, prompt: "boot", label },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { agent_id: string; session_id: string };
  const token = h.tokens.mint(body.session_id);
  return { agentId: body.agent_id, sessionId: body.session_id, token };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Open a message thread: manager sends to worker, returns the reply token. */
async function openThread(
  h: Harness,
  ws: string,
): Promise<{ manager: Spawned; worker: Spawned; replyToken: string }> {
  const manager = await spawn(h, ws, "manager", "mgr");
  const worker = await spawn(h, ws, "worker", "wkr");
  const send = await h.server.inject({
    method: "POST",
    url: "/agent/messages",
    headers: bearer(manager.token),
    payload: { recipient_agent_id: worker.agentId, body: "status?" },
  });
  expect(send.statusCode).toBe(200);
  const replyToken = (send.json() as { token: string }).token;
  return { manager, worker, replyToken };
}

// ---------------------------------------------------------------------------
// AC1: Reply lands on originator's tip AFTER originator cycled
// ---------------------------------------------------------------------------

describe("AC1 — reply after originator cycled", () => {
  it("routes to a freshly-spawned manager session (not 410 on dead session id)", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { manager, worker, replyToken } = await openThread(h, ws);

    // Simulate originator cycling: end its session so injectPrompt(originator_session_id)
    // would return 410 under the old code.
    h.sessions.markEnded(manager.sessionId);

    const spawnsBefore = h.control.agents.length;

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(worker.token),
      payload: { token: replyToken, body: "migration was clean" },
    });

    // Fixed: reply delivered (spawned new session for manager). Old code returns 410.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { action?: string; replied_at?: number };
    expect(body.action).toMatch(/spawned|resumed|injected|queued/);
    expect(typeof body.replied_at).toBe("number");

    // Token consumed exactly once.
    const tokenRow = h.db
      .prepare("SELECT redeemed_at FROM agent_message_tokens WHERE token = ?")
      .get(replyToken) as { redeemed_at: number | null };
    expect(tokenRow.redeemed_at).not.toBeNull();

    // A new session was spawned for the originator.
    expect(h.control.agents.length).toBeGreaterThan(spawnsBefore);

    await teardown(h);
  });
});

// ---------------------------------------------------------------------------
// AC2: Reply succeeds after RECIPIENT cycled
// ---------------------------------------------------------------------------

describe("AC2 — reply after recipient cycled", () => {
  it("agent-equality authz passes for a new session of the same worker", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { manager, worker, replyToken } = await openThread(h, ws);

    // Simulate recipient cycling: end the original session and create a new one
    // for the same agent (same agent_id, new session_id and token).
    h.sessions.markEnded(worker.sessionId);

    const workerSession = h.sessions.get(worker.sessionId)!;
    const newWorkerSessionId = randomUUID();
    h.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, workspace_id, role_id, runtime_provider, pid, started_at)
         VALUES (?, ?, ?, ?, 'claude', 9001, ?)`,
      )
      .run(newWorkerSessionId, worker.agentId, ws, workerSession.role_id, Date.now());
    const newWorkerToken = h.tokens.mint(newWorkerSessionId);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(newWorkerToken),
      payload: { token: replyToken, body: "done — migration ran clean" },
    });

    // Fixed: passes (agent-equality). Old code returns 403 (session-id mismatch).
    expect(res.statusCode).toBe(200);
    const body = res.json() as { action?: string; replied_at?: number };
    expect(body.action).toBeDefined();
    expect(typeof body.replied_at).toBe("number");

    await teardown(h);
  });
});

// ---------------------------------------------------------------------------
// AC3: Different agent still rejected (regression)
// ---------------------------------------------------------------------------

describe("AC3 — different agent rejected (regression)", () => {
  it("returns 403 when a different agent tries to redeem the token", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { replyToken } = await openThread(h, ws);
    const interloper = await spawn(h, ws, "worker", "wkr-2");

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(interloper.token),
      payload: { token: replyToken, body: "not mine" },
    });

    expect(res.statusCode).toBe(403);
    await teardown(h);
  });
});

// ---------------------------------------------------------------------------
// AC4: Failed delivery does NOT burn the token (the reorder)
// ---------------------------------------------------------------------------

describe("AC4 — failed delivery does not consume the reply token", () => {
  it("token redeemed_at stays null when deliver() returns errored", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { manager, worker, replyToken } = await openThread(h, ws);

    // Force deliver() to return {action:"errored"}: delete the originator agent so
    // agents.get(originator_agent_id) === null. Sessions survive (ON DELETE SET NULL
    // on sessions.agent_id), so the token's session FKs remain intact and the token
    // row itself is not cascade-deleted.
    h.db.prepare("DELETE FROM agents WHERE id = ?").run(manager.agentId);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(worker.token),
      payload: { token: replyToken, body: "attempted reply" },
    });

    // Delivery errored — route should return a non-200 status.
    expect(res.statusCode).not.toBe(200);

    // The critical invariant: token NOT redeemed (reorder fix).
    // Old code redeems BEFORE delivery attempt, burning the token even on failure.
    const tokenRow = h.db
      .prepare("SELECT redeemed_at FROM agent_message_tokens WHERE token = ?")
      .get(replyToken) as { redeemed_at: number | null } | null;
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.redeemed_at).toBeNull();

    await teardown(h);
  });
});

// ---------------------------------------------------------------------------
// AC5: Route returns outcome.action; CLI has a confirmation line to print
// ---------------------------------------------------------------------------

describe("AC5 — route response includes outcome.action", () => {
  it("reply response body includes action field alongside replied_at", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { manager, worker, replyToken } = await openThread(h, ws);

    // Idle originator → immediate injection into the live session.
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: manager.sessionId,
        transcript_path: "/tmp/t.jsonl",
        cwd: "/r",
        permission_mode: "default" as const,
        hook_event_name: "Stop" as const,
      },
    });

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(worker.token),
      payload: { token: replyToken, body: "done" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { action?: string; replied_at?: number };

    // Old code returns only { replied_at }; fixed code adds action.
    expect(body.action).toBeDefined();
    expect(typeof body.action).toBe("string");
    expect(typeof body.replied_at).toBe("number");

    await teardown(h);
  });
});
