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
import type { AgentSpawner } from "../src/types.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-workspace-reports-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  agentStatusLog: ReturnType<typeof createAgentStatusLogStore>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionTokens = createSessionTokenStore(db);
  const agentStatusLog = createAgentStatusLogStore(db);
  const spawner: AgentSpawner = (req) => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId,
      pid: 9500,
      exited: new Promise<number | null>(() => {}),
      stdin,
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
    sessionTokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog,
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
    apiBase: "http://127.0.0.1:3300",
    cliEntry: "/abs/cli/index.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, agents, sessions, agentStatusLog };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface ReportEntry {
  session_id: string;
  role: string;
  label?: string;
  summary: string;
  created_at: number;
  report: { well?: string; badly?: string; useful?: string; free_text?: string };
}

interface ReportsBody {
  reports: ReportEntry[];
}

describe("GET /workspaces/:id/reports", () => {
  it("404s for an unknown workspace", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: "/workspaces/00000000-0000-0000-0000-000000000000/reports",
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns an empty list when the workspace has no reports", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/reports`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ReportsBody).reports).toEqual([]);

    await teardown(h);
  });

  it("surfaces a final-report for an ENDED session, newest first, with label + role + structured report", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "issue-42",
    });
    h.sessions.create({
      id: "session-ended-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9501,
      label: "worker-issue-42",
    });
    h.sessions.markEnded("session-ended-1");

    h.agentStatusLog.append({
      agent_id: agent.id,
      session_id: "session-ended-1",
      kind: "final-report",
      state: "final",
      summary: "well: shipped clean | badly: nothing",
      details: { well: "shipped clean", badly: "nothing" },
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/reports`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsBody;
    expect(body.reports).toHaveLength(1);
    const entry = body.reports[0]!;
    expect(entry.session_id).toBe("session-ended-1");
    expect(entry.role).toBe("worker");
    expect(entry.label).toBe("worker-issue-42");
    expect(entry.summary).toBe("well: shipped clean | badly: nothing");
    expect(entry.report).toMatchObject({ well: "shipped clean", badly: "nothing" });

    await teardown(h);
  });

  it("a session with no final report contributes nothing to the list", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id, label: "no-report" });
    h.sessions.create({
      id: "session-no-report",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9502,
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/reports`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ReportsBody).reports).toEqual([]);

    await teardown(h);
  });

  it("orders multiple reports newest first", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    for (const n of [1, 2]) {
      const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id, label: `t${n}` });
      h.sessions.create({
        id: `session-${n}`,
        agent_id: agent.id,
        workspace_id: ws.id,
        role_id: role.id,
        pid: 9502 + n,
      });
      h.sessions.markEnded(`session-${n}`);
      h.agentStatusLog.append({
        agent_id: agent.id,
        session_id: `session-${n}`,
        kind: "final-report",
        state: "final",
        summary: `report ${n}`,
        details: { free_text: `report ${n}` },
      });
    }

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/reports`,
    });
    const body = res.json() as ReportsBody;
    expect(body.reports.map((r) => r.session_id)).toEqual(["session-2", "session-1"]);

    await teardown(h);
  });
});
