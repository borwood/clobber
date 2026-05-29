import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
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
import { createRoleContractRefusalStore } from "../src/role-contract-refusal-store.ts";
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
    refusals: createRoleContractRefusalStore(db),
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
    roleContractRefusals: s.refusals,
    agentQuestions: s.agentQuestions,
    agentQuestionWaiter: s.agentQuestionWaiter,
    runtimeProvider: turnProvider(),
    spawner: noopSpawner(),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/abs/cli.ts",
    dispatches: s.dispatches,
    finalReportConsumerState: s.finalReportConsumerState,
  });
}

describe("boot-time role-contract compat sweep (#239)", () => {
  it("incompatible adopted version → session-independent refusal row (agent_id NULL); compatible version untouched; boot not wedged", async () => {
    const s = buildStores();
    const ws = s.workspaces.create({ name: "ws", repo_path: "/tmp/x" });

    // A freshly created version is stamped at the engine's contract version →
    // compatible → no refusal.
    const good = s.roles.create({ name: "worker", persistent: false });
    s.workspaceRoles.setCeiling(ws.id, good.id, 1);

    // The only schema-valid mismatch is a higher stamp (contract_version is a
    // positive int; the engine ships v1), which the empty v1 migrator cannot
    // bridge → incompatible.
    const bad = s.roles.create({ name: "manager", persistent: true });
    s.workspaceRoles.setCeiling(ws.id, bad.id, 1);
    const badVersionId = bad.current_version_id!;
    const badContract = ENGINE_CONTRACT_VERSION + 1;
    s.db
      .prepare("UPDATE role_versions SET contract_version = ? WHERE id = ?")
      .run(badContract, badVersionId);

    // Boot runs the sweep. It must NOT throw on the incompatible version.
    const server = boot(s);

    const refusals = s.refusals.listForWorkspace(ws.id);
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0]!;
    expect(refusal.role_id).toBe(bad.id);
    expect(refusal.role_name).toBe("manager");
    expect(refusal.role_version_id).toBe(badVersionId);
    expect(refusal.authored_contract_version).toBe(badContract);
    expect(refusal.engine_contract_version).toBe(ENGINE_CONTRACT_VERSION);
    // The adopt boundary has no agent — the refusal is session-independent.
    expect(refusal.agent_id).toBeNull();

    // The compatible role produced nothing.
    expect(refusals.some((r) => r.role_id === good.id)).toBe(false);

    // Boot completed and the workspace is not wedged — the server still serves.
    const res = await server.inject({ method: "GET", url: "/workspaces" });
    expect(res.statusCode).toBe(200);

    await server.close();
    s.db.close();
  });

  it("all adopted versions compatible → no refusals; boot clean", async () => {
    const s = buildStores();
    const ws = s.workspaces.create({ name: "ws", repo_path: "/tmp/x" });
    const role = s.roles.create({ name: "worker", persistent: false });
    s.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const server = boot(s);

    expect(s.refusals.listForWorkspace(ws.id)).toHaveLength(0);
    const res = await server.inject({ method: "GET", url: "/workspaces" });
    expect(res.statusCode).toBe(200);

    await server.close();
    s.db.close();
  });
});
