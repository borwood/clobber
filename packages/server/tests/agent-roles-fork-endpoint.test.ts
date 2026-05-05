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
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

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
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  let pidCounter = 9000;
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
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return { server, db, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repo: RepoFixture;
let otherRepo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-roles-fork-");
  otherRepo = makeRepoFixture("clobber-roles-fork-other-");
});

afterEach(() => {
  repo.cleanup();
  otherRepo.cleanup();
});

interface Booted {
  workspaceId: string;
  managerToken: string;
  managerSessionId: string;
  managerRoleId: string;
  workerRoleId: string;
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
    managerToken: token,
    managerSessionId: boot.session_id,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
  };
}

describe("POST /agent/roles/:id/fork", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${boot.workerRoleId}/fork`,
      payload: { new_name: "auditor" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("forks a workspace role by id and creates a workspace-scoped role at version 1", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${boot.workerRoleId}/fork`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "auditor" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      role_id: string;
      version_id: string;
      version: number;
    };
    expect(typeof body.role_id).toBe("string");
    expect(typeof body.version_id).toBe("string");
    expect(body.version).toBe(1);

    const newRole = h.db
      .prepare("SELECT name, workspace_id, current_version_id FROM roles WHERE id = ?")
      .get(body.role_id) as
      | { name: string; workspace_id: string; current_version_id: string }
      | null;
    expect(newRole).not.toBeNull();
    expect(newRole!.name).toBe("auditor");
    expect(newRole!.workspace_id).toBe(boot.workspaceId);
    expect(newRole!.current_version_id).toBe(body.version_id);

    const newVersion = h.db
      .prepare(
        "SELECT version, role_id, system_prompt FROM role_versions WHERE id = ?",
      )
      .get(body.version_id) as
      | { version: number; role_id: string; system_prompt: string }
      | null;
    expect(newVersion).not.toBeNull();
    expect(newVersion!.version).toBe(1);
    expect(newVersion!.role_id).toBe(body.role_id);

    const sourceVersionRow = h.db
      .prepare(
        "SELECT system_prompt FROM role_versions WHERE id = (SELECT current_version_id FROM roles WHERE id = ?)",
      )
      .get(boot.workerRoleId) as { system_prompt: string } | null;
    expect(sourceVersionRow).not.toBeNull();
    expect(newVersion!.system_prompt).toBe(sourceVersionRow!.system_prompt);

    await teardown(h);
  });

  it("looks up source role by name within the caller's workspace", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/roles/worker/fork",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "auditor" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { role_id: string };

    const row = h.db
      .prepare("SELECT name FROM roles WHERE id = ?")
      .get(body.role_id) as { name: string } | null;
    expect(row!.name).toBe("auditor");

    await teardown(h);
  });

  it("appears in `GET /agent/roles` after the fork", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    await h.server.inject({
      method: "POST",
      url: "/agent/roles/worker/fork",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "auditor" },
    });

    const listRes = await h.server.inject({
      method: "GET",
      url: "/agent/roles",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as { roles: Array<{ name: string }> };
    const names = list.roles.map((r) => r.name).sort();
    expect(names).toEqual(["auditor", "manager", "worker"]);

    await teardown(h);
  });

  it("returns 409 when new_name conflicts with an existing role in the workspace", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${boot.workerRoleId}/fork`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "manager" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/exists|already/i);

    await teardown(h);
  });

  it("returns 400 when new_name fails the role-name format", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    for (const bad of ["", "has space", "weird/slash", "dot.dot", "@nope"]) {
      const res = await h.server.inject({
        method: "POST",
        url: `/agent/roles/${boot.workerRoleId}/fork`,
        headers: { authorization: `Bearer ${boot.managerToken}` },
        payload: { new_name: bad },
      });
      expect(res.statusCode).toBe(400);
    }

    await teardown(h);
  });

  it("accepts dashes and underscores in new_name", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${boot.workerRoleId}/fork`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "code_review-bot2" },
    });
    expect(res.statusCode).toBe(201);

    await teardown(h);
  });

  it("returns 404 for an unknown source name", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/roles/nonsense/fork",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "auditor" },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("returns 404 when source role belongs to another workspace", async () => {
    const h = buildHarness();
    const bootA = await bootInWorkspace(h, repo.path);
    const bootB = await bootInWorkspace(h, otherRepo.path);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${bootB.workerRoleId}/fork`,
      headers: { authorization: `Bearer ${bootA.managerToken}` },
      payload: { new_name: "auditor" },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("returns 400 when body is missing new_name", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${boot.workerRoleId}/fork`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });
});
