import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serializeUserMessage } from "@clobber/runtime";
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
import { createNotificationStore } from "../src/notification-store.ts";
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
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-msg-"));
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

// injectPrompt writes straight to stdin whether the recipient is busy or idle
// (the clobber inject queue was removed in #367 — claude's native queue defers a
// mid-turn write). The Stop hook flips a freshly-spawned (busy) session to idle.
async function fireStop(h: Harness, sessionId: string): Promise<void> {
  const res = await h.server.inject({
    method: "POST",
    url: "/hook",
    payload: {
      session_id: sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/r",
      permission_mode: "default" as const,
      hook_event_name: "Stop" as const,
    },
  });
  expect(res.statusCode).toBe(200);
}

function writesFor(h: Harness, sessionId: string): string {
  const stub = h.control.agents.find((a) => a.sessionId === sessionId);
  if (stub === undefined) throw new Error(`no stub for ${sessionId}`);
  return stub.writes.join("");
}

describe("POST /agent/messages — manager → worker send", () => {
  it("injects the message as <clobber type=\"message\" from token> on the recipient", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const manager = await spawn(h, ws, "manager", "mgr");
    const worker = await spawn(h, ws, "worker", "wkr");
    await fireStop(h, worker.sessionId); // idle recipient → immediate stdin write

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages",
      headers: bearer(manager.token),
      payload: { recipient_agent_id: worker.agentId, body: "did you check the migration?" },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { message_id: string; token: string; sent_at: number };
    expect(typeof out.message_id).toBe("string");
    expect(out.token.length).toBeGreaterThanOrEqual(8);
    expect(out.token.length).toBeLessThanOrEqual(12);
    expect(typeof out.sent_at).toBe("number");

    const expected = serializeUserMessage("did you check the migration?", {
      kind: "message",
      attrs: { from: "mgr", token: out.token },
    });
    expect(writesFor(h, worker.sessionId)).toBe(expected);

    // Token row bound to (originator, recipient, message_id), not yet redeemed.
    const tokenRow = h.db
      .prepare("SELECT * FROM agent_message_tokens WHERE token = ?")
      .get(out.token) as {
      originator_session_id: string;
      recipient_session_id: string;
      message_id: string;
      redeemed_at: number | null;
    } | null;
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.originator_session_id).toBe(manager.sessionId);
    expect(tokenRow!.recipient_session_id).toBe(worker.sessionId);
    expect(tokenRow!.message_id).toBe(out.message_id);
    expect(tokenRow!.redeemed_at).toBeNull();

    // Audit row kind=message state=sent on the manager's agent.
    const logRow = h.db
      .prepare(
        "SELECT kind, state, agent_id FROM agent_status_log WHERE session_id = ? AND kind = 'message'",
      )
      .get(manager.sessionId) as { kind: string; state: string; agent_id: string } | null;
    expect(logRow).not.toBeNull();
    expect(logRow!.state).toBe("sent");
    expect(logRow!.agent_id).toBe(manager.agentId);

    await teardown(h);
  });

  it("records the message as a durable high-priority notification (#425 spine)", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const manager = await spawn(h, ws, "manager", "mgr");
    const worker = await spawn(h, ws, "worker", "wkr");
    await fireStop(h, worker.sessionId);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages",
      headers: bearer(manager.token),
      payload: { recipient_agent_id: worker.agentId, body: "ping" },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { token: string; message_id: string };

    const store = createNotificationStore(h.db);
    const notifs = store.listForAgent(worker.agentId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.type).toBe("message");
    expect(notifs[0]!.priority).toBe("high");
    expect(notifs[0]!.state).toBe("delivered");
    expect(notifs[0]!.recipient).toEqual({ kind: "agent", agent_id: worker.agentId });
    expect(notifs[0]!.payload.body).toBe("ping");
    expect(notifs[0]!.metadata["reply_capability"]).toBe(out.token);

    await teardown(h);
  });

  it("returns 404 for a recipient agent in a different workspace", async () => {
    const h = buildHarness();
    const wsA = makeWorkspace(h);
    const wsB = makeWorkspace(h);
    const manager = await spawn(h, wsA, "manager", "mgr");
    const workerB = await spawn(h, wsB, "worker", "wkr-b");

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages",
      headers: bearer(manager.token),
      payload: { recipient_agent_id: workerB.agentId, body: "cross-ws" },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 410 when the recipient session has ended", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const manager = await spawn(h, ws, "manager", "mgr");
    const worker = await spawn(h, ws, "worker", "wkr");

    h.sessions.markEnded(worker.sessionId);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages",
      headers: bearer(manager.token),
      payload: { recipient_agent_id: worker.agentId, body: "you there?" },
    });
    expect(res.statusCode).toBe(410);
    await teardown(h);
  });

  it("denies a worker initiating a message (lacks the `message` capability) → 403", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const workerA = await spawn(h, ws, "worker", "wkr-a");
    const workerB = await spawn(h, ws, "worker", "wkr-b");

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages",
      headers: bearer(workerA.token),
      payload: { recipient_agent_id: workerB.agentId, body: "psst" },
    });
    expect(res.statusCode).toBe(403);
    await teardown(h);
  });
});

describe("POST /agent/messages/replies — worker → originator reply", () => {
  async function openThread(
    h: Harness,
    ws: string,
  ): Promise<{ manager: Spawned; worker: Spawned; token: string }> {
    const manager = await spawn(h, ws, "manager", "mgr");
    const worker = await spawn(h, ws, "worker", "wkr");
    const send = await h.server.inject({
      method: "POST",
      url: "/agent/messages",
      headers: bearer(manager.token),
      payload: { recipient_agent_id: worker.agentId, body: "status?" },
    });
    expect(send.statusCode).toBe(200);
    const token = (send.json() as { token: string }).token;
    return { manager, worker, token };
  }

  it("redeems the token and injects <clobber type=\"message-reply\"> on the originator", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { manager, worker, token } = await openThread(h, ws);
    await fireStop(h, manager.sessionId); // idle originator → immediate stdin write

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(worker.token),
      payload: { token, body: "yes, migration was clean" },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof (res.json() as { replied_at: number }).replied_at).toBe("number");

    const expected = serializeUserMessage("yes, migration was clean", {
      kind: "message-reply",
      attrs: { from: "wkr" },
    });
    expect(writesFor(h, manager.sessionId)).toBe(expected);

    // Token now redeemed.
    const tokenRow = h.db
      .prepare("SELECT redeemed_at FROM agent_message_tokens WHERE token = ?")
      .get(token) as { redeemed_at: number | null };
    expect(tokenRow.redeemed_at).not.toBeNull();

    // Audit row kind=message-reply on the worker's agent (its floor entry — Q2).
    const logRow = h.db
      .prepare(
        "SELECT state, agent_id FROM agent_status_log WHERE session_id = ? AND kind = 'message-reply'",
      )
      .get(worker.sessionId) as { state: string; agent_id: string } | null;
    expect(logRow).not.toBeNull();
    expect(logRow!.state).toBe("replied");
    expect(logRow!.agent_id).toBe(worker.agentId);

    await teardown(h);
  });

  it("returns 410 on a double-redeem of the same token", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { worker, token } = await openThread(h, ws);

    const first = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(worker.token),
      payload: { token, body: "one" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(worker.token),
      payload: { token, body: "two" },
    });
    expect(second.statusCode).toBe(410);
    await teardown(h);
  });

  it("returns 404 for an unknown token", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const worker = await spawn(h, ws, "worker", "wkr");

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(worker.token),
      payload: { token: "deadbeef00", body: "hello" },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 403 when a session that is not the addressed recipient redeems the token", async () => {
    const h = buildHarness();
    const ws = makeWorkspace(h);
    const { token } = await openThread(h, ws);
    const interloper = await spawn(h, ws, "worker", "wkr-2");

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/messages/replies",
      headers: bearer(interloper.token),
      payload: { token, body: "not mine" },
    });
    expect(res.statusCode).toBe(403);
    await teardown(h);
  });
});
