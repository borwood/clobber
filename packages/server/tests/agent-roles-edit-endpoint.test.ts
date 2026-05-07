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
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  let pidCounter = 9300;
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
let otherRepo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-roles-edit-");
  otherRepo = makeRepoFixture("clobber-roles-edit-other-");
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

interface VersionRow {
  id: string;
  version: number;
  system_prompt: string;
  skills_json: string;
  allowed_tools_json: string;
  hooks_json: string;
}

function readCurrentVersion(h: Harness, roleId: string): VersionRow {
  const row = h.db
    .prepare(
      `SELECT v.id, v.version, v.system_prompt, v.skills_json, v.allowed_tools_json, v.hooks_json
       FROM role_versions v
       JOIN roles r ON r.current_version_id = v.id
       WHERE r.id = ?`,
    )
    .get(roleId) as VersionRow | null;
  if (row === null) throw new Error(`no current version for ${roleId}`);
  return row;
}

describe("PATCH /agent/roles/:idOrName", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      payload: { system_prompt: "you are a tester" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("PATCH only system_prompt creates v2 and copies skills/allowed_tools/hooks", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const before = readCurrentVersion(h, boot.workerRoleId);
    expect(before.version).toBe(1);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "you are a careful tester" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role_id: string;
      version_id: string;
      version: number;
    };
    expect(body.role_id).toBe(boot.workerRoleId);
    expect(body.version).toBe(2);
    expect(body.version_id).not.toBe(before.id);

    const after = readCurrentVersion(h, boot.workerRoleId);
    expect(after.version).toBe(2);
    expect(after.system_prompt).toBe("you are a careful tester");
    expect(after.skills_json).toBe(before.skills_json);
    expect(after.allowed_tools_json).toBe(before.allowed_tools_json);
    expect(after.hooks_json).toBe(before.hooks_json);

    await teardown(h);
  });

  it("PATCH only allowed_tools creates v2 and copies system_prompt/skills/hooks", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const before = readCurrentVersion(h, boot.workerRoleId);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { allowed_tools: ["Read", "Grep"] },
    });
    expect(res.statusCode).toBe(200);

    const after = readCurrentVersion(h, boot.workerRoleId);
    expect(after.version).toBe(2);
    expect(after.system_prompt).toBe(before.system_prompt);
    expect(JSON.parse(after.allowed_tools_json)).toEqual(["Read", "Grep"]);
    expect(after.skills_json).toBe(before.skills_json);
    expect(after.hooks_json).toBe(before.hooks_json);

    await teardown(h);
  });

  it("PATCH only skills creates v2 and copies system_prompt/allowed_tools/hooks", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const before = readCurrentVersion(h, boot.workerRoleId);

    const skills = [
      { name: "linting", body: "# Linting\nUse the linter." },
      { name: "testing", body: "# Testing\nWrite tests first." },
    ];
    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { skills },
    });
    expect(res.statusCode).toBe(200);

    const after = readCurrentVersion(h, boot.workerRoleId);
    expect(after.version).toBe(2);
    expect(JSON.parse(after.skills_json)).toEqual(skills);
    expect(after.system_prompt).toBe(before.system_prompt);
    expect(after.allowed_tools_json).toBe(before.allowed_tools_json);
    expect(after.hooks_json).toBe(before.hooks_json);

    await teardown(h);
  });

  it("PATCH multiple fields at once creates a single new version", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: {
        system_prompt: "merged",
        allowed_tools: ["Read"],
        skills: [{ name: "s", body: "b" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: number };
    expect(body.version).toBe(2);

    const totalVersions = h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?",
      )
      .get(boot.workerRoleId) as { n: number };
    expect(totalVersions.n).toBe(2);

    await teardown(h);
  });

  it("multiple sequential PATCHes increment version each time", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    for (const expected of [2, 3, 4]) {
      const res = await h.server.inject({
        method: "PATCH",
        url: `/agent/roles/${boot.workerRoleId}`,
        headers: { authorization: `Bearer ${boot.managerToken}` },
        payload: { system_prompt: `prompt v${expected}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { version: number };
      expect(body.version).toBe(expected);
    }

    const after = readCurrentVersion(h, boot.workerRoleId);
    expect(after.version).toBe(4);
    expect(after.system_prompt).toBe("prompt v4");

    await teardown(h);
  });

  it("rejects body containing hooks with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "ok", hooks: { PostToolUse: [] } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/hooks/i);

    await teardown(h);
  });

  it("rejects body containing permission_mode with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "ok", permission_mode: "acceptEdits" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/permission_mode/i);

    await teardown(h);
  });

  it("PATCH only description updates roles.description and does NOT bump version", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const before = readCurrentVersion(h, boot.workerRoleId);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { description: "rewritten description" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role_id: string;
      description?: string;
      version?: number;
    };
    expect(body.role_id).toBe(boot.workerRoleId);
    expect(body.description).toBe("rewritten description");
    expect(body.version).toBeUndefined();

    const after = readCurrentVersion(h, boot.workerRoleId);
    expect(after.id).toBe(before.id);
    expect(after.version).toBe(1);

    const descRow = h.db
      .prepare("SELECT description FROM roles WHERE id = ?")
      .get(boot.workerRoleId) as { description: string };
    expect(descRow.description).toBe("rewritten description");

    const totalVersions = h.db
      .prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?")
      .get(boot.workerRoleId) as { n: number };
    expect(totalVersions.n).toBe(1);

    await teardown(h);
  });

  it("PATCH description + system_prompt bumps version AND updates description", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { description: "new desc", system_prompt: "new prompt" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role_id: string;
      description?: string;
      version?: number;
    };
    expect(body.version).toBe(2);
    expect(body.description).toBe("new desc");

    const descRow = h.db
      .prepare("SELECT description FROM roles WHERE id = ?")
      .get(boot.workerRoleId) as { description: string };
    expect(descRow.description).toBe("new desc");

    const after = readCurrentVersion(h, boot.workerRoleId);
    expect(after.system_prompt).toBe("new prompt");

    await teardown(h);
  });

  it("rejects empty-string description with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { description: "" },
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });

  it("rejects empty body with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });

  it("PATCH by role name resolves within the caller's workspace", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: "/agent/roles/worker",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "by name" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { role_id: string; version: number };
    expect(body.role_id).toBe(boot.workerRoleId);
    expect(body.version).toBe(2);

    await teardown(h);
  });

  it("returns 404 for an unknown role", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: "/agent/roles/nonsense",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "x" },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("returns 404 when role belongs to another workspace", async () => {
    const h = buildHarness();
    const bootA = await bootInWorkspace(h, repo.path);
    const bootB = await bootInWorkspace(h, otherRepo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${bootB.workerRoleId}`,
      headers: { authorization: `Bearer ${bootA.managerToken}` },
      payload: { system_prompt: "x" },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("live session keeps its boot version after edit; new spawn uses the new version", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const liveSpawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: boot.workspaceId,
        role_id: boot.workerRoleId,
        prompt: "live",
        label: "boot",
      },
    });
    expect(liveSpawnRes.statusCode).toBe(200);
    const liveSpawn = liveSpawnRes.json() as { session_id: string };

    const livePinned = h.db
      .prepare("SELECT role_version_id FROM sessions WHERE id = ?")
      .get(liveSpawn.session_id) as { role_version_id: string } | null;
    expect(livePinned).not.toBeNull();
    const v1Id = livePinned!.role_version_id;

    const editRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "after edit" },
    });
    expect(editRes.statusCode).toBe(200);
    const v2 = editRes.json() as { version_id: string; version: number };
    expect(v2.version).toBe(2);
    expect(v2.version_id).not.toBe(v1Id);

    const livePinnedAfter = h.db
      .prepare("SELECT role_version_id FROM sessions WHERE id = ?")
      .get(liveSpawn.session_id) as { role_version_id: string };
    expect(livePinnedAfter.role_version_id).toBe(v1Id);

    const newSpawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: boot.workspaceId,
        role_id: boot.workerRoleId,
        prompt: "after",
        label: "boot",
      },
    });
    expect(newSpawnRes.statusCode).toBe(200);
    const newSpawn = newSpawnRes.json() as { session_id: string };
    const newPinned = h.db
      .prepare("SELECT role_version_id FROM sessions WHERE id = ?")
      .get(newSpawn.session_id) as { role_version_id: string };
    expect(newPinned.role_version_id).toBe(v2.version_id);

    await teardown(h);
  });
});
