import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const roleVersions = createRoleVersionStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions,
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

describe("Stop hook → context_tokens in session summary", () => {
  it("stores context_tokens from transcript and surfaces them in session summary", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "test", repo_path: "/r" });
    const role = h.roles.create({ name: "worker", persistent: false });
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
    const sessionId = randomUUID();
    h.sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: ws.id, role_id: role.id, pid: 1 });

    const dir = await mkdtemp(join(tmpdir(), "ctx-test-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    // Minimal assistant turn carrying a usage block (50k input tokens).
    const usageLine = JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    await writeFile(transcriptPath, usageLine + "\n");

    const stopPayload = {
      hook_event_name: "Stop",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: "/tmp",
      permission_mode: "default",
    };
    const res = await h.server.inject({ method: "POST", url: "/hook", payload: stopPayload });
    expect(res.statusCode).toBe(200);

    const summaries = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    })).json() as SessionSummary[];

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.context_tokens).toBe(50000);

    await h.server.close();
    h.db.close();
  });

  it("leaves context_tokens absent when transcript has no usage block", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "test2", repo_path: "/r" });
    const role = h.roles.create({ name: "worker", persistent: false });
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
    const sessionId = randomUUID();
    h.sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: ws.id, role_id: role.id, pid: 1 });

    const dir = await mkdtemp(join(tmpdir(), "ctx-test-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    await writeFile(transcriptPath, JSON.stringify({ type: "system", content: "boot" }) + "\n");

    const stopPayload = {
      hook_event_name: "Stop",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: "/tmp",
      permission_mode: "default",
    };
    await h.server.inject({ method: "POST", url: "/hook", payload: stopPayload });

    const summaries = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    })).json() as SessionSummary[];

    expect(summaries[0]!.context_tokens).toBeUndefined();

    await h.server.close();
    h.db.close();
  });
});
