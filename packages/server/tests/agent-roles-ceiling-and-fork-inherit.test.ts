import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  let pidCounter = 9700;
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
  repo = makeRepoFixture("clobber-roles-ceiling-");
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

function readCeiling(
  h: Harness,
  workspaceId: string,
  roleId: string,
): number | null {
  const row = h.db
    .prepare(
      "SELECT max_concurrent FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?",
    )
    .get(workspaceId, roleId) as { max_concurrent: number } | null;
  return row === null ? null : row.max_concurrent;
}

describe("forkRole inherits source ceiling so the fork is not stuck at capacity 0", () => {
  it("copies the source role's ceiling to the new role on fork", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);

    const sourceCeiling = readCeiling(h, boot.workspaceId, boot.workerRoleId);
    expect(sourceCeiling).not.toBeNull();
    expect(sourceCeiling).toBeGreaterThan(0);

    const forkRes = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${boot.workerRoleId}/fork`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "auditor" },
    });
    expect(forkRes.statusCode).toBe(201);
    const body = forkRes.json() as { role_id: string };

    const forkedCeiling = readCeiling(h, boot.workspaceId, body.role_id);
    expect(forkedCeiling).toBe(sourceCeiling);

    await teardown(h);
  });

  it("spawning a freshly forked role succeeds and materializes the plugin tree from DB-only state", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);

    const forkRes = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${boot.workerRoleId}/fork`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { new_name: "auditor" },
    });
    const body = forkRes.json() as { role_id: string };

    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: boot.workspaceId,
        role_id: body.role_id,
        prompt: "hello",
        label: "boot",
      },
    });
    expect(spawnRes.statusCode).toBe(200);

    const auditorPluginDir = join(repo.path, ".clobber", "roles", "auditor");
    const pluginJsonPath = join(auditorPluginDir, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
      name: string;
    };
    expect(pluginJson.name).toBe("auditor");

    const hooksPath = join(auditorPluginDir, "hooks", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const hooksRaw = readFileSync(hooksPath, "utf8");
    expect(hooksRaw).not.toContain("__CLOBBER_HOOK_URL__");
    expect(hooksRaw).toContain("http://test.invalid/hook");

    for (const skill of ["whoami", "ask", "status"]) {
      expect(
        existsSync(join(auditorPluginDir, "skills", skill, "SKILL.md")),
      ).toBe(true);
    }

    await teardown(h);
  });
});

describe("PUT /agent/roles/:idOrName/ceiling lets manager set ceilings in its workspace", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);
    const res = await h.server.inject({
      method: "PUT",
      url: `/agent/roles/${boot.workerRoleId}/ceiling`,
      payload: { max_concurrent: 7 },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("upserts the ceiling for the caller's workspace by role id", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);
    const res = await h.server.inject({
      method: "PUT",
      url: `/agent/roles/${boot.workerRoleId}/ceiling`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { max_concurrent: 9 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      workspace_id: string;
      role_id: string;
      max_concurrent: number;
    };
    expect(body.workspace_id).toBe(boot.workspaceId);
    expect(body.role_id).toBe(boot.workerRoleId);
    expect(body.max_concurrent).toBe(9);
    expect(readCeiling(h, boot.workspaceId, boot.workerRoleId)).toBe(9);
    await teardown(h);
  });

  it("resolves the role by name within the caller's workspace", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);
    const res = await h.server.inject({
      method: "PUT",
      url: "/agent/roles/worker/ceiling",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { max_concurrent: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(readCeiling(h, boot.workspaceId, boot.workerRoleId)).toBe(4);
    await teardown(h);
  });

  it("rejects a negative max_concurrent with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);
    const res = await h.server.inject({
      method: "PUT",
      url: `/agent/roles/${boot.workerRoleId}/ceiling`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { max_concurrent: -1 },
    });
    expect(res.statusCode).toBe(400);
    await teardown(h);
  });

  it("returns 404 for a role that does not exist in the caller's workspace", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);
    const res = await h.server.inject({
      method: "PUT",
      url: "/agent/roles/00000000-0000-4000-8000-000000000000/ceiling",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { max_concurrent: 3 },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("0 is a valid ceiling and disables spawning", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h);
    await h.server.inject({
      method: "PUT",
      url: `/agent/roles/${boot.workerRoleId}/ceiling`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { max_concurrent: 0 },
    });
    expect(readCeiling(h, boot.workspaceId, boot.workerRoleId)).toBe(0);
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: boot.workspaceId,
        role_id: boot.workerRoleId,
        prompt: "blocked",
        label: "boot",
      },
    });
    expect(spawnRes.statusCode).toBe(403);
    await teardown(h);
  });
});
