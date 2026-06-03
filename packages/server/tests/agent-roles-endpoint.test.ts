import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { RoleListEntrySchema, RoleDetailResponseSchema } from "@clobber/shared";
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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import type {
  AgentSpawner,
  AgentSpawnRequest,
  SpawnedAgentInfo,
} from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
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
  const tokens = createSessionTokenStore(db);
  const calls: AgentSpawnRequest[] = [];
  let pidCounter = 7000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    calls.push(req);
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
  return { server, db, workspaces, roles, workspaceRoles, tokens, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repo: RepoFixture;
let otherRepo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-agent-roles-");
  otherRepo = makeRepoFixture("clobber-agent-roles-other-");
});

afterEach(() => {
  repo.cleanup();
  otherRepo.cleanup();
});

interface Booted {
  workspaceId: string;
  managerSessionId: string;
  managerToken: string;
  workerRoleId: string;
  managerRoleId: string;
}

async function bootInWorkspace(h: Harness, repoPath: string): Promise<Booted> {
  const wsRes = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: `ws-${repoPath}`, repo_path: repoPath },
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
    managerSessionId: boot.session_id,
    managerToken: token,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
  };
}

describe("GET /agent/roles", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const res = await h.server.inject({ method: "GET", url: "/agent/roles" });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 for a revoked token", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    h.tokens.revoke(boot.managerSessionId);
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/roles",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("lists workspace-scoped roles (manager + worker) with version metadata", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/roles",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      roles: Array<{
        id: string;
        name: string;
        persistent: boolean;
        version: number;
        allowed_tools?: string[];
      }>;
    };
    const byName = new Map(body.roles.map((r) => [r.name, r]));
    expect(byName.has("manager")).toBe(true);
    expect(byName.has("worker")).toBe(true);
    expect(byName.get("manager")!.persistent).toBe(true);
    expect(byName.get("worker")!.persistent).toBe(false);
    expect(byName.get("manager")!.version).toBe(1);
    expect(byName.get("worker")!.version).toBe(1);
    // After #491: current_version_id is removed from RoleListEntry.
    expect(byName.get("manager")!.allowed_tools).toContain("Bash");

    for (const entry of body.roles) {
      RoleListEntrySchema.parse(entry);
    }

    await teardown(h);
  });

  it("does NOT include heavy fields (system_prompt, skills) in the list", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/roles",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    const body = res.json() as { roles: Array<Record<string, unknown>> };
    for (const r of body.roles) {
      expect(r["system_prompt"]).toBeUndefined();
      expect(r["skills"]).toBeUndefined();
    }
    await teardown(h);
  });

  it("does not include roles from other workspaces", async () => {
    const h = buildHarness();
    const bootA = await bootInWorkspace(h, repo.path);
    const bootB = await bootInWorkspace(h, otherRepo.path);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/roles",
      headers: { authorization: `Bearer ${bootA.managerToken}` },
    });
    const body = res.json() as { roles: Array<{ id: string }> };
    const ids = body.roles.map((r) => r.id);
    expect(ids).toContain(bootA.managerRoleId);
    expect(ids).toContain(bootA.workerRoleId);
    expect(ids).not.toContain(bootB.managerRoleId);
    expect(ids).not.toContain(bootB.workerRoleId);

    await teardown(h);
  });
});

describe("GET /agent/roles/:idOrName", () => {
  it("returns full role + current version + version_history when looked up by id", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "GET",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      id: string;
      name: string;
      persistent: boolean;
      current_version: {
        id: string;
        version: number;
        system_prompt: string;
        skills: Array<{ name: string; body: string }>;
        allowed_tools: string[];
        hooks: unknown;
        created_at: number;
      };
      version_history: Array<{ id: string; version: number; created_at: number }>;
    };
    expect(body.id).toBe(boot.workerRoleId);
    expect(body.name).toBe("worker");
    expect(body.persistent).toBe(false);
    expect(body.current_version.version).toBe(1);
    expect(body.current_version.system_prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(body.current_version.skills)).toBe(true);
    expect(body.current_version.allowed_tools).toContain("Bash");
    expect(body.version_history).toHaveLength(1);
    expect(body.version_history[0]!.version).toBe(1);
    expect(body.version_history[0]!.id).toBe(body.current_version.id);

    RoleDetailResponseSchema.parse(body);

    await teardown(h);
  });

  it("looks up by name within the caller's workspace", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/roles/worker",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; name: string };
    expect(body.id).toBe(boot.workerRoleId);
    expect(body.name).toBe("worker");

    await teardown(h);
  });

  it("returns 404 for a role in another workspace by id", async () => {
    const h = buildHarness();
    const bootA = await bootInWorkspace(h, repo.path);
    const bootB = await bootInWorkspace(h, otherRepo.path);

    const res = await h.server.inject({
      method: "GET",
      url: `/agent/roles/${bootB.workerRoleId}`,
      headers: { authorization: `Bearer ${bootA.managerToken}` },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("returns 404 for an unknown name", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/roles/nonsense",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "GET",
      url: `/agent/roles/${boot.workerRoleId}`,
    });
    expect(res.statusCode).toBe(401);

    await teardown(h);
  });
});
