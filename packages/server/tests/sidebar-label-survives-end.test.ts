import { describe, it, expect } from "bun:test";
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
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  repoPath: string;
}

function buildHarness(opts: { persistent: boolean }): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-sidebar-label-"));
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: "manager", persistent: opts.persistent });
  workspaceRoles.setCeiling(ws.id, role.id, 1);
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId,
      pid: 9000,
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
    sessionTokens: createSessionTokenStore(db),
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
  return { server, db, workspaces, roles, workspaceRoles, agents, sessions, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

interface SummaryRow {
  session_id: string;
  label?: string;
  ended_at?: number;
}

async function listSummaries(h: Harness): Promise<SummaryRow[]> {
  const wsId = h.db.query<{ id: string }, []>("SELECT id FROM workspaces").all()[0]!.id;
  const res = await h.server.inject({
    method: "GET",
    url: `/sessions?workspace_id=${wsId}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as SummaryRow[];
}

async function spawn(h: Harness, label: string): Promise<{ session_id: string; agent_id: string }> {
  const wsId = h.db.query<{ id: string }, []>("SELECT id FROM workspaces").all()[0]!.id;
  const roleId = h.db.query<{ id: string }, []>("SELECT id FROM roles").all()[0]!.id;
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: roleId, prompt: "go", label },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { session_id: string; agent_id: string };
}

describe("sidebar label survives non-persistent session end (#?)", () => {
  it("non-persistent ended session keeps its label even after the agent row is deleted", async () => {
    const h = buildHarness({ persistent: false });
    const spawned = await spawn(h, "fix-the-bug");

    // Sanity: label visible while agent row still exists.
    const before = await listSummaries(h);
    expect(before.find((s) => s.session_id === spawned.session_id)?.label).toBe("fix-the-bug");

    // End the session — for non-persistent roles this deletes the agent row.
    const endRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });
    expect(endRes.statusCode).toBe(200);
    expect(h.agents.get(spawned.agent_id)).toBeNull(); // confirm the deletion happened

    // Regression: label must still be on the summary so the sidebar doesn't
    // fall back to displaying the session UUID.
    const after = await listSummaries(h);
    const summary = after.find((s) => s.session_id === spawned.session_id);
    expect(summary).toBeDefined();
    expect(summary!.label).toBe("fix-the-bug");
    expect(typeof summary!.ended_at).toBe("number");

    await teardown(h);
  });

  it("persistent ended session also keeps its label (no regression for the persistent case)", async () => {
    const h = buildHarness({ persistent: true });
    const spawned = await spawn(h, "manager-1");

    await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });

    const after = await listSummaries(h);
    const summary = after.find((s) => s.session_id === spawned.session_id);
    expect(summary?.label).toBe("manager-1");

    await teardown(h);
  });
});
