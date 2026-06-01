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
import type { AgentSpawner, AgentSpawnRequest, SpawnedAgentInfo } from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  sessionSummaries: ReturnType<typeof createWorkspaceSessionSummaries>;
  calls: AgentSpawnRequest[];
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
  const sessionSummaries = createWorkspaceSessionSummaries(db);
  const tokens = createSessionTokenStore(db);
  const calls: AgentSpawnRequest[] = [];
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    calls.push(req);
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 4321,
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
    sessionSummaries,
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
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens, sessionSummaries, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-session-model-effort-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

describe("session model/effort persistence", () => {
  it("persists the resolved model and effort overrides onto the session record", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    // Role has no model/effort defaults — overrides are the only source of truth
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: role.id,
        prompt: "do something",
        label: "test-worker",
        model: "sonnet",
        effort: "low",
      },
    });
    expect(res.statusCode).toBe(200);
    const { session_id } = res.json() as { session_id: string };

    const session = h.sessions.get(session_id);
    expect(session).not.toBeNull();
    expect(session!.model).toBe("sonnet");
    expect(session!.effort).toBe("low");

    await teardown(h);
  });

  it("persists the role default model/effort when no override is supplied", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({
      name: "worker",
      persistent: false,
      model: "opus",
      effort: "high",
    });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: role.id,
        prompt: "do something",
        label: "test-worker",
      },
    });
    expect(res.statusCode).toBe(200);
    const { session_id } = res.json() as { session_id: string };

    const session = h.sessions.get(session_id);
    expect(session).not.toBeNull();
    expect(session!.model).toBe("opus");
    expect(session!.effort).toBe("high");

    await teardown(h);
  });

  it("exposes model and effort through session summaries", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: role.id,
        prompt: "do something",
        label: "test-worker",
        model: "haiku",
        effort: "medium",
      },
    });

    const summaries = h.sessionSummaries.list(ws.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.model).toBe("haiku");
    expect(summaries[0]!.effort).toBe("medium");

    await teardown(h);
  });
});
