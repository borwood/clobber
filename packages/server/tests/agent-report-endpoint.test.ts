import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
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
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
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
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
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
  repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-report-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function bootAgent(h: Harness): Promise<BootedAgent> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({ name: "worker", persistent: false });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string; agent_id: string };
  const token = h.tokens.mint(body.session_id);
  return { workspaceId: ws.id, agentId: body.agent_id, sessionId: body.session_id, token };
}

interface LogRow {
  id: number;
  agent_id: string;
  session_id: string;
  kind: string;
  state: string;
  summary: string;
  details_json: string | null;
  created_at: number;
}

function readReports(h: Harness, sessionId: string): LogRow[] {
  return h.db
    .prepare(
      "SELECT * FROM agent_status_log WHERE session_id = ? AND kind = 'final-report' ORDER BY created_at ASC, id ASC",
    )
    .all(sessionId) as LogRow[];
}

describe("POST /agent/report — final-report emission (#83)", () => {
  it("writes a final-report row with structured triple", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: {
        well: "tests landed clean on first try",
        badly: "spent too long re-reading the explore",
        useful: "a /assignment skill that pre-seeds the todo list",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ ok: true });

    const rows = readReports(h, boot.sessionId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.agent_id).toBe(boot.agentId);
    expect(row.kind).toBe("final-report");
    expect(JSON.parse(row.details_json!)).toMatchObject({
      well: "tests landed clean on first try",
      badly: "spent too long re-reading the explore",
      useful: "a /assignment skill that pre-seeds the todo list",
    });
    expect(row.summary.length).toBeGreaterThan(0);

    await teardown(h);
  });

  it("writes a final-report with only some structured fields", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { well: "shipped" },
    });
    expect(res.statusCode).toBe(200);

    const rows = readReports(h, boot.sessionId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.details_json!)).toMatchObject({ well: "shipped" });

    await teardown(h);
  });

  it("writes a final-report with free_text fallback", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { free_text: "shipped, all tests green, no notes" },
    });
    expect(res.statusCode).toBe(200);

    const rows = readReports(h, boot.sessionId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.details_json!)).toMatchObject({
      free_text: "shipped, all tests green, no notes",
    });

    await teardown(h);
  });

  it("rejects an empty payload with 400", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(readReports(h, boot.sessionId)).toHaveLength(0);

    await teardown(h);
  });

  it("rejects a second final-report from the same session with 409", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const first = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { well: "first" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { well: "second" },
    });
    expect(second.statusCode).toBe(409);

    const rows = readReports(h, boot.sessionId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.details_json!)).toMatchObject({ well: "first" });

    await teardown(h);
  });

  it("rejects without bearer token (401)", async () => {
    const h = buildHarness();
    await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      payload: { well: "x" },
    });
    expect(res.statusCode).toBe(401);

    await teardown(h);
  });

  it("does not allow positional summary alongside structured fields", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { well: "x", free_text: "y" },
    });
    expect(res.statusCode).toBe(400);
    expect(readReports(h, boot.sessionId)).toHaveLength(0);

    await teardown(h);
  });
});
