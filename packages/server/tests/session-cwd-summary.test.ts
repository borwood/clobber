import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { stubSpawnedAgent } from "./_spawner-stub.ts";
import type { SessionSummary } from "../src/workspace-session-summaries.ts";

function buildHarness() {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent(),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, agents, sessions };
}

async function summaries(h: ReturnType<typeof buildHarness>, wsId: string): Promise<SessionSummary[]> {
  return (await h.server.inject({ method: "GET", url: `/sessions?workspace_id=${wsId}` })).json() as SessionSummary[];
}

async function postHook(h: ReturnType<typeof buildHarness>, sessionId: string, cwd: string): Promise<void> {
  await h.server.inject({
    method: "POST",
    url: "/hook",
    payload: {
      hook_event_name: "Notification",
      session_id: sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd,
      permission_mode: "default",
    },
  });
}

describe("session summary surfaces the agent's latest working directory (cwd)", () => {
  it("reports the cwd from the most recent hook event carrying one", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "test", repo_path: "/r" });
    const role = h.roles.create({ name: "worker", persistent: false });
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
    const sessionId = randomUUID();
    h.sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: ws.id, role_id: role.id, pid: 1 });

    await postHook(h, sessionId, "/work/clobber-worktrees/feature-a");
    await postHook(h, sessionId, "/work/clobber-worktrees/feature-b");

    const list = await summaries(h, ws.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.cwd).toBe("/work/clobber-worktrees/feature-b");

    await h.server.close();
    h.db.close();
  });

  it("leaves cwd absent for a session with no events", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "test2", repo_path: "/r" });
    const role = h.roles.create({ name: "worker", persistent: false });
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
    const sessionId = randomUUID();
    h.sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: ws.id, role_id: role.id, pid: 1 });

    const list = await summaries(h, ws.id);
    expect(list[0]!.cwd).toBeUndefined();

    await h.server.close();
    h.db.close();
  });
});
