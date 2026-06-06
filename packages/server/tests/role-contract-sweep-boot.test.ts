import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, expect, it } from "bun:test";
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
import { turnProvider } from "./_spawn-harness.ts";
import type { AgentSpawner } from "../src/types.ts";

// #239 — the boot-time compat sweep: the session-less analog of the #237 spawn
// gate, across every role version a workspace has adopted, batched. The seam is
// already cut (role-contract-compat.ts names "the engine-adopt sweep (#239)").
// These drive the sweep THROUGH the real boot path: seed role versions, mutate
// a stamp so it no longer matches the engine contract, boot the server, and
// observe the refuse-with-signal — a session-independent refusal row with no
// agent — without the server ever being wedged.

function noopSpawner(): AgentSpawner {
  return (req) => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId,
      pid: 7777,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };
}

function buildStores() {
  const db = createDatabase(":memory:");
  return {
    db,
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
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  };
}

type Stores = ReturnType<typeof buildStores>;

function boot(s: Stores) {
  return createServer({
    db: s.db,
    store: createEventStore(s.db),
    workspaces: s.workspaces,
    roles: s.roles,
    roleVersions: s.roleVersions,
    workspaceRoles: s.workspaceRoles,
    agents: s.agents,
    sessions: s.sessions,
    sessionSummaries: s.sessionSummaries,
    sessionTokens: s.sessionTokens,
    agentStatuses: s.agentStatuses,
    agentStatusLog: s.agentStatusLog,
    agentQuestions: s.agentQuestions,
    agentQuestionWaiter: s.agentQuestionWaiter,
    runtimeProvider: turnProvider(),
    spawner: noopSpawner(),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/abs/cli.ts",
    dispatches: s.dispatches,
    finalReportConsumerState: s.finalReportConsumerState,
  });
}

// #491 — boot-time role-contract sweep is removed (all roles are commit-pinned
// and current by construction; no version-row gate needed at boot).
describe("boot-time role-contract sweep removed (#491)", () => {
  it("boot does not crash even with version_rows present; no refusal rows written", async () => {
    const s = buildStores();
    const ws = s.workspaces.create({ name: "ws", repo_path: "/tmp/x" });
    const role = s.roles.create({ name: "worker", persistent: false });
    s.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // Boot must not crash even if version rows exist.
    const server = boot(s);
    const res = await server.inject({ method: "GET", url: "/workspaces" });
    expect(res.statusCode).toBe(200);

    await server.close();
    s.db.close();
  });
});
