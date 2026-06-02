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
  repoPath: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(repoPath: string): Harness {
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
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens, repoPath };
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
  repoPath = mkdtempSync(join(tmpdir(), "clobber-finding-"));
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
  commit: string | null;
  role_version_id: string | null;
  created_at: number;
}

function readFindings(h: Harness, sessionId: string): LogRow[] {
  return h.db
    .prepare(
      "SELECT * FROM agent_status_log WHERE session_id = ? AND kind = 'finding' ORDER BY id ASC",
    )
    .all(sessionId) as LogRow[];
}

describe("POST /agent/finding — append-many triage-drop (#167)", () => {
  it("appends a kind=finding row with the provided summary", async () => {
    const h = buildHarness(repoPath);
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/finding",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { summary: "disk usage spike correlates with prompt-module seeding" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ ok: true });

    const rows = readFindings(h, boot.sessionId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("finding");
    expect(row.state).toBe("finding");
    expect(row.summary).toBe("disk usage spike correlates with prompt-module seeding");
    expect(row.agent_id).toBe(boot.agentId);

    await teardown(h);
  });

  it("is repeatable — multiple findings in the same session all persist", async () => {
    const h = buildHarness(repoPath);
    const boot = await bootAgent(h);

    for (const text of ["first finding", "second finding", "third finding"]) {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/finding",
        headers: { authorization: `Bearer ${boot.token}` },
        payload: { summary: text },
      });
      expect(res.statusCode).toBe(200);
    }

    const rows = readFindings(h, boot.sessionId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.summary)).toEqual(["first finding", "second finding", "third finding"]);

    await teardown(h);
  });

  it("inherits #221 provenance — commit and role_version_id columns present on the row", async () => {
    const h = buildHarness(repoPath);
    const boot = await bootAgent(h);

    await h.server.inject({
      method: "POST",
      url: "/agent/finding",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { summary: "provenance test" },
    });

    const rows = readFindings(h, boot.sessionId);
    expect(rows).toHaveLength(1);
    // commit and role_version_id exist as columns (may be null for non-git repoPath,
    // but the column itself is present on every row — that's the provenance contract)
    expect("commit" in rows[0]!).toBe(true);
    expect("role_version_id" in rows[0]!).toBe(true);

    await teardown(h);
  });

  it("rejects without bearer token with 401", async () => {
    const h = buildHarness(repoPath);
    await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/finding",
      payload: { summary: "x" },
    });
    expect(res.statusCode).toBe(401);

    await teardown(h);
  });

  it("rejects an empty summary with 400", async () => {
    const h = buildHarness(repoPath);
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/finding",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { summary: "" },
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });
});

describe("GET /agent/reports — triage reader includes findings alongside final-reports (#167)", () => {
  it("lists findings and final-reports together, each labeled by kind", async () => {
    const h = buildHarness(repoPath);
    const boot = await bootAgent(h);

    await h.server.inject({
      method: "POST",
      url: "/agent/finding",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { summary: "a triage observation" },
    });
    await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { well: "landed green" },
    });

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/reports",
      headers: { authorization: `Bearer ${boot.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reports: Array<{ kind: string; summary: string; session_id: string }>;
    };
    expect(body.reports.length).toBeGreaterThanOrEqual(2);
    const kinds = body.reports.map((r) => r.kind);
    expect(kinds).toContain("finding");
    expect(kinds).toContain("final-report");

    await teardown(h);
  });
});
