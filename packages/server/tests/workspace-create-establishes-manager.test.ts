import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
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
import { establishSingletonAgentsForWorkspace } from "../src/establish-singleton-agents.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
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
  let pidCounter = 7300;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
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
    sessionTokens: createSessionTokenStore(db),
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
  return { server, db, agents, sessions };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-establish-manager-");
});

afterEach(() => {
  repo.cleanup();
});

describe("workspace create establishes the manager agent (#694)", () => {
  it("creates exactly one manager agent, and no agent for the non-persistent worker role", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: `ws-${repo.path}`, repo_path: repo.path },
    });
    expect(res.statusCode).toBe(201);
    const ws = res.json() as { id: string };

    const rows = h.db
      .prepare(
        `SELECT r.name AS role_name FROM agents a JOIN roles r ON r.id = a.role_id WHERE a.workspace_id = ?`,
      )
      .all(ws.id) as Array<{ role_name: string }>;
    expect(rows.map((r) => r.role_name)).toEqual(["manager"]);

    await teardown(h);
  });

  it("the manager agent has no live session at creation — the trigger drives the first session", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: `ws-${repo.path}`, repo_path: repo.path },
    });
    const ws = res.json() as { id: string };
    const managerAgent = h.db
      .prepare(
        `SELECT a.id AS id FROM agents a JOIN roles r ON r.id = a.role_id WHERE a.workspace_id = ? AND r.name = 'manager'`,
      )
      .get(ws.id) as { id: string };

    expect(h.sessions.latestForAgent(managerAgent.id)).toBeNull();

    await teardown(h);
  });

  it("load-bearing (AC4): real POST /workspaces → manager agent exists → workspace-open fires through the real scheduler and reaches the manager", async () => {
    const h = buildHarness();
    const wsRes = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: `ws-${repo.path}`, repo_path: repo.path },
    });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json() as { id: string };

    const managerAgent = h.db
      .prepare(
        `SELECT a.id AS id FROM agents a JOIN roles r ON r.id = a.role_id WHERE a.workspace_id = ? AND r.name = 'manager'`,
      )
      .get(ws.id) as { id: string } | null;
    expect(managerAgent).not.toBeNull();

    const fireRes = await h.server.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/open`,
      payload: {},
    });
    expect(fireRes.statusCode).toBe(200);
    const body = fireRes.json() as { dispatched: number };
    expect(body.dispatched).toBe(1);

    const session = h.sessions.latestForAgent(managerAgent!.id);
    expect(session).not.toBeNull();
    expect(session!.wake_program).toBe("bootstrap-interview");

    await teardown(h);
  });

  it("is idempotent: re-running the establish step for the same workspace does not duplicate the manager agent", async () => {
    const h = buildHarness();
    const wsRes = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: `ws-${repo.path}`, repo_path: repo.path },
    });
    const ws = wsRes.json() as { id: string };

    const again = establishSingletonAgentsForWorkspace(h.db, ws.id);
    expect(again.createdAgentIds).toEqual([]);

    const count = (
      h.db
        .prepare(
          `SELECT COUNT(*) AS n FROM agents a JOIN roles r ON r.id = a.role_id WHERE a.workspace_id = ? AND r.name = 'manager'`,
        )
        .get(ws.id) as { n: number }
    ).n;
    expect(count).toBe(1);

    await teardown(h);
  });

  it("POST /spawn for the manager role reuses the already-established session-less agent instead of double-instantiating", async () => {
    const h = buildHarness();
    const wsRes = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: `ws-${repo.path}`, repo_path: repo.path },
    });
    const ws = wsRes.json() as { id: string };
    const managerRole = h.db
      .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = 'manager'")
      .get(ws.id) as { id: string };
    const establishedAgent = h.db
      .prepare("SELECT id FROM agents WHERE workspace_id = ? AND role_id = ?")
      .get(ws.id, managerRole.id) as { id: string };

    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: managerRole.id,
        prompt: "boot",
        label: "boot",
      },
    });
    expect(spawnRes.statusCode).toBe(200);
    const spawned = spawnRes.json() as { agent_id: string };
    expect(spawned.agent_id).toBe(establishedAgent.id);

    const count = (
      h.db
        .prepare("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND role_id = ?")
        .get(ws.id, managerRole.id) as { n: number }
    ).n;
    expect(count).toBe(1);

    await teardown(h);
  });

  it("POST /spawn for the manager role refuses once every agent for the role already holds a live session", async () => {
    const h = buildHarness();
    const wsRes = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: `ws-${repo.path}`, repo_path: repo.path },
    });
    const ws = wsRes.json() as { id: string };
    const managerRole = h.db
      .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = 'manager'")
      .get(ws.id) as { id: string };

    // First spawn reuses (and wakes) the established agent, filling it with a
    // live session — at ceiling 1 there is now no session-less agent left.
    const firstSpawn = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boot" },
    });
    expect(firstSpawn.statusCode).toBe(200);

    const secondSpawn = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "again", label: "again" },
    });
    expect(secondSpawn.statusCode).toBe(403);
    expect((secondSpawn.json() as { error: string }).error).toBe("role at capacity");

    const count = (
      h.db
        .prepare("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND role_id = ?")
        .get(ws.id, managerRole.id) as { n: number }
    ).n;
    expect(count).toBe(1);

    await teardown(h);
  });
});
