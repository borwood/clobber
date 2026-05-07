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

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pidCounter = 9500;
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
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
    sessionSummaries: createWorkspaceSessionSummaries(db),
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
  });
  return { server, db, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-role-version-ui-");
});

afterEach(() => {
  repo.cleanup();
});

interface Booted {
  workspaceId: string;
  managerToken: string;
  managerRoleId: string;
  workerRoleId: string;
}

async function bootInWorkspace(h: Harness): Promise<Booted> {
  const wsRes = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "ws", repo_path: repo.path },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  const workerRow = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", ws.id) as { id: string } | null;
  if (managerRow === null || workerRow === null) {
    throw new Error("seed missing manager/worker");
  }

  const bootRes = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const token = h.tokens.mint(boot.session_id);

  return {
    workspaceId: ws.id,
    managerToken: token,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
  };
}

describe("GET /workspaces/:wid/roles surfaces current_version for the picker", () => {
  it("returns current_version: { id, version } for each seeded role", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);

    const list = await h.server.inject({
      method: "GET",
      url: `/workspaces/${boot.workspaceId}/roles`,
    });
    expect(list.statusCode).toBe(200);
    const assignments = list.json() as Array<{
      role: { id: string; name: string; current_version_id?: string };
      current_version?: { id: string; version: number };
      max_concurrent: number;
    }>;
    const worker = assignments.find((a) => a.role.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!.current_version).toBeDefined();
    expect(worker!.current_version!.version).toBe(1);
    expect(worker!.role.current_version_id).toBeDefined();
    expect(worker!.current_version!.id).toBe(worker!.role.current_version_id!);

    await teardown(h);
  });

  it("reflects a bumped version after PATCH /agent/roles/:id", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);

    const editRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "v2 prompt" },
    });
    expect(editRes.statusCode).toBe(200);

    const list = await h.server.inject({
      method: "GET",
      url: `/workspaces/${boot.workspaceId}/roles`,
    });
    const assignments = list.json() as Array<{
      role: { name: string };
      current_version?: { version: number };
    }>;
    const worker = assignments.find((a) => a.role.name === "worker");
    expect(worker!.current_version!.version).toBe(2);

    await teardown(h);
  });
});

describe("GET /sessions surfaces pinned + current role versions", () => {
  it("includes role_version (pinned) and role_current_version on each session", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);

    const list = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${boot.workspaceId}`,
    });
    expect(list.statusCode).toBe(200);
    const sessions = list.json() as Array<{
      session_id: string;
      role_name: string;
      role_version?: { id: string; version: number };
      role_current_version?: { id: string; version: number };
    }>;
    expect(sessions.length).toBeGreaterThan(0);
    const managerSession = sessions.find((s) => s.role_name === "manager");
    expect(managerSession).toBeDefined();
    expect(managerSession!.role_version).toBeDefined();
    expect(managerSession!.role_version!.version).toBe(1);
    expect(managerSession!.role_current_version).toBeDefined();
    expect(managerSession!.role_current_version!.version).toBe(1);
    expect(managerSession!.role_version!.id).toBe(
      managerSession!.role_current_version!.id,
    );

    await teardown(h);
  });

  it("pinned version stays at v1 after editing the role; current advances to v2", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);

    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: boot.workspaceId,
        role_id: boot.workerRoleId,
        prompt: "hello",
        label: "boot",
      },
    });
    expect(spawnRes.statusCode).toBe(200);
    const spawn = spawnRes.json() as { session_id: string };

    await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "after edit" },
    });

    const list = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${boot.workspaceId}`,
    });
    const sessions = list.json() as Array<{
      session_id: string;
      role_version?: { version: number };
      role_current_version?: { version: number };
    }>;
    const live = sessions.find((s) => s.session_id === spawn.session_id);
    expect(live).toBeDefined();
    expect(live!.role_version!.version).toBe(1);
    expect(live!.role_current_version!.version).toBe(2);

    await teardown(h);
  });
});
