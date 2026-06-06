import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
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

function buildHarness() {
  const db = createDatabase(":memory:");
  let invocations = 0;
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),

    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => {
      invocations += 1;
      return stubSpawnedAgent({ sessionId: "x" });
    },
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return {
    server,
    db,
    invocationCount: () => invocations,
  };
}

describe("POST /spawn — request validation", () => {
  it("accepts a request missing prompt — prompt is optional since #501", async () => {
    // Prompt is no longer required: named/default programs supply their own kick
    // and `custom` with no prompt means boot-and-wait (idle behavior).
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: "00000000-0000-4000-8000-000000000001",
        role_id: "00000000-0000-4000-8000-000000000002",
        label: "boot",
      },
    });

    // Schema valid — but workspace doesn't exist in this harness → 404.
    expect(res.statusCode).toBe(404);
    expect(h.invocationCount()).toBe(0);

    await h.server.close();
    h.db.close();
  });

  it("rejects a request missing workspace_id with 400", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { role_id: "00000000-0000-4000-8000-000000000002", prompt: "hi", label: "boot" },
    });

    expect(res.statusCode).toBe(400);
    expect(h.invocationCount()).toBe(0);

    await h.server.close();
    h.db.close();
  });

  it("rejects a request missing role_id with 400", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: "00000000-0000-4000-8000-000000000001", prompt: "hi", label: "boot" },
    });

    expect(res.statusCode).toBe(400);
    expect(h.invocationCount()).toBe(0);

    await h.server.close();
    h.db.close();
  });

  it("rejects non-uuid workspace_id with 400", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: "not-a-uuid",
        role_id: "00000000-0000-4000-8000-000000000002",
        prompt: "hi",
        label: "boot",
      },
    });

    expect(res.statusCode).toBe(400);

    await h.server.close();
    h.db.close();
  });

  it("rejects a request with no label with 400 and 'label is required' (#36)", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: "00000000-0000-4000-8000-000000000001",
        role_id: "00000000-0000-4000-8000-000000000002",
        prompt: "hi",
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("label is required");
    expect(h.invocationCount()).toBe(0);
    await h.server.close();
    h.db.close();
  });

  it("rejects a request with empty/whitespace label with 400 (#36)", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: "00000000-0000-4000-8000-000000000001",
        role_id: "00000000-0000-4000-8000-000000000002",
        prompt: "hi",
        label: "   ",
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("label is required");
    expect(h.invocationCount()).toBe(0);
    await h.server.close();
    h.db.close();
  });
});
