import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
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
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9999,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };
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
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface BootedAgent {
  workspaceId: string;
  agentId: string;
  sessionId: string;
  token: string;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-status-log-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function bootAgent(h: Harness): Promise<BootedAgent> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string; agent_id: string };
  const token = h.tokens.mint(body.session_id);
  return {
    workspaceId: ws.id,
    agentId: body.agent_id,
    sessionId: body.session_id,
    token,
  };
}

interface LogRow {
  id: number;
  agent_id: string;
  session_id: string;
  event_id: number | null;
  kind: string;
  state: string;
  summary: string;
  details_json: string | null;
  created_at: number;
}

function readLog(h: Harness, agentId: string): LogRow[] {
  return h.db
    .prepare(
      "SELECT * FROM agent_status_log WHERE agent_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(agentId) as LogRow[];
}

describe("POST /agent/status — append-only log alongside snapshot (#69)", () => {
  it("appends one log row per status emission, keyed by agent_id", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "working", summary: "refactoring auth" },
    });
    expect(res.statusCode).toBe(200);

    const rows = readLog(h, boot.agentId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.agent_id).toBe(boot.agentId);
    expect(row.session_id).toBe(boot.sessionId);
    expect(row.kind).toBe("status");
    expect(row.state).toBe("working");
    expect(row.summary).toBe("refactoring auth");
    expect(row.details_json).toBeNull();
    expect(row.event_id).toBeNull();
    expect(typeof row.created_at).toBe("number");

    await teardown(h);
  });

  it("does NOT upsert — every emission is a new row (snapshot is upserted, log appends)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    for (const [state, summary] of [
      ["working", "first"],
      ["blocked", "second"],
      ["working", "third"],
    ] as const) {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/status",
        headers: { authorization: `Bearer ${boot.token}` },
        payload: { state, summary },
      });
      expect(res.statusCode).toBe(200);
    }

    const logRows = readLog(h, boot.agentId);
    expect(logRows).toHaveLength(3);
    expect(logRows.map((r) => r.summary)).toEqual(["first", "second", "third"]);
    expect(logRows.map((r) => r.state)).toEqual(["working", "blocked", "working"]);

    // Snapshot still has exactly one row, latest wins.
    const snapshotCount = h.db
      .prepare("SELECT COUNT(*) AS n FROM agent_statuses WHERE session_id = ?")
      .get(boot.sessionId) as { n: number };
    expect(snapshotCount.n).toBe(1);
    const snapshot = h.db
      .prepare("SELECT state, summary FROM agent_statuses WHERE session_id = ?")
      .get(boot.sessionId) as { state: string; summary: string };
    expect(snapshot.state).toBe("working");
    expect(snapshot.summary).toBe("third");

    await teardown(h);
  });

  it("preserves details JSON on log rows", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: {
        state: "blocked",
        summary: "waiting",
        details: { issue: 42, options: ["a", "b"] },
      },
    });

    const rows = readLog(h, boot.agentId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.details_json!)).toEqual({
      issue: 42,
      options: ["a", "b"],
    });

    await teardown(h);
  });

  it("does not write a log row when the route rejects the input", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "bogus-state", summary: "x" },
    });
    expect(res.statusCode).toBe(400);

    expect(readLog(h, boot.agentId)).toHaveLength(0);

    await teardown(h);
  });
});

describe("AgentStatusLogStore.listForAgent", () => {
  it("returns entries for one agent, newest-first, with default limit", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    for (const summary of ["one", "two", "three"]) {
      await h.server.inject({
        method: "POST",
        url: "/agent/status",
        headers: { authorization: `Bearer ${boot.token}` },
        payload: { state: "working", summary },
      });
    }

    const store = createAgentStatusLogStore(h.db);
    const entries = store.listForAgent(boot.agentId);
    expect(entries.map((e) => e.summary)).toEqual(["three", "two", "one"]);

    await teardown(h);
  });

  it("respects limit", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    for (const summary of ["one", "two", "three", "four"]) {
      await h.server.inject({
        method: "POST",
        url: "/agent/status",
        headers: { authorization: `Bearer ${boot.token}` },
        payload: { state: "working", summary },
      });
    }

    const store = createAgentStatusLogStore(h.db);
    const entries = store.listForAgent(boot.agentId, { limit: 2 });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.summary)).toEqual(["four", "three"]);

    await teardown(h);
  });
});
