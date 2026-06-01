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
import { deskDirFor } from "../src/desk-store.ts";
import { officePathFor } from "../src/office-store.ts";
import type { SessionLocationsResponse } from "@clobber/shared";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  repoPath: string;
}

function buildHarness(opts: { persistent: boolean }): Harness {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-session-locations-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);

  const ws = workspaces.create({ name: "test-ws", repo_path: repoPath });
  const role = roles.create({ name: "worker", persistent: opts.persistent });
  workspaceRoles.setCeiling(ws.id, role.id, 3);

  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId,
      pid: 1234,
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

  return { server, db, repoPath };
}

async function spawnSession(
  h: Harness,
): Promise<{ session_id: string; agent_id: string }> {
  const wsId = h.db.query<{ id: string }, []>("SELECT id FROM workspaces").all()[0]!.id;
  const roleId = h.db.query<{ id: string }, []>("SELECT id FROM roles").all()[0]!.id;
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: roleId, prompt: "go", label: "test" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { session_id: string; agent_id: string };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

describe("GET /sessions/:id/locations", () => {
  it("returns desk_path derived from the agent id and workspace repo", async () => {
    const h = buildHarness({ persistent: false });
    const { session_id, agent_id } = await spawnSession(h);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${session_id}/locations`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionLocationsResponse;
    expect(body.desk_path).toBe(deskDirFor(h.repoPath, agent_id));
    await teardown(h);
  });

  it("returns office_path=null for an ephemeral (non-persistent) role", async () => {
    const h = buildHarness({ persistent: false });
    const { session_id } = await spawnSession(h);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${session_id}/locations`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionLocationsResponse;
    expect(body.office_path).toBeNull();
    await teardown(h);
  });

  it("returns office_path for a persistent role", async () => {
    const h = buildHarness({ persistent: true });
    const { session_id, agent_id } = await spawnSession(h);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${session_id}/locations`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionLocationsResponse;
    expect(body.office_path).toBe(officePathFor(h.repoPath, agent_id));
    await teardown(h);
  });

  it("returns 404 for an unknown session id", async () => {
    const h = buildHarness({ persistent: false });

    const res = await h.server.inject({
      method: "GET",
      url: "/sessions/00000000-0000-0000-0000-000000000000/locations",
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });
});
