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
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
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
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9999,
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
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface BootedAgent {
  workspaceId: string;
  sessionId: string;
  token: string;
  roleId: string;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-status-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function bootAgent(h: Harness): Promise<BootedAgent> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string };
  const token = h.tokens.mint(body.session_id);
  return {
    workspaceId: ws.id,
    sessionId: body.session_id,
    token,
    roleId: role.id,
  };
}

describe("POST /agent/status", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      payload: { state: "working", summary: "doing things" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 for an unknown bearer token", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: { state: "working", summary: "doing things" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 400 when state is not one of the known values", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "bogus", summary: "x" },
    });
    expect(res.statusCode).toBe(400);
    await teardown(h);
  });

  it("returns 400 when summary is missing or empty", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "working", summary: "" },
    });
    expect(res.statusCode).toBe(400);
    await teardown(h);
  });

  it("upserts a status row keyed by the caller's session", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "working", summary: "refactoring auth middleware" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ ok: true });

    const row = h.db
      .prepare("SELECT state, summary, details_json FROM agent_statuses WHERE session_id = ?")
      .get(boot.sessionId) as
      | { state: string; summary: string; details_json: string | null }
      | null;
    expect(row).not.toBeNull();
    expect(row!.state).toBe("working");
    expect(row!.summary).toBe("refactoring auth middleware");
    expect(row!.details_json).toBeNull();

    await teardown(h);
  });

  it("overwrites the existing status on subsequent calls (one row per session)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "working", summary: "first" },
    });
    await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "blocked", summary: "second" },
    });

    const rowCount = h.db
      .prepare("SELECT COUNT(*) AS n FROM agent_statuses WHERE session_id = ?")
      .get(boot.sessionId) as { n: number };
    expect(rowCount.n).toBe(1);

    const row = h.db
      .prepare("SELECT state, summary FROM agent_statuses WHERE session_id = ?")
      .get(boot.sessionId) as { state: string; summary: string };
    expect(row.state).toBe("blocked");
    expect(row.summary).toBe("second");

    await teardown(h);
  });

  it("persists optional details as JSON", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: {
        state: "blocked",
        summary: "waiting on schema decision",
        details: { issue: 42, options: ["a", "b"] },
      },
    });
    expect(res.statusCode).toBe(200);

    const row = h.db
      .prepare("SELECT details_json FROM agent_statuses WHERE session_id = ?")
      .get(boot.sessionId) as { details_json: string };
    expect(JSON.parse(row.details_json)).toEqual({ issue: 42, options: ["a", "b"] });

    await teardown(h);
  });

  it("status=done does NOT end the session (status and lifecycle are independent)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "done", summary: "task finished, awaiting next prompt" },
    });
    expect(res.statusCode).toBe(200);

    const session = h.sessions.get(boot.sessionId);
    expect(session).not.toBeNull();
    expect(session!.ended_at).toBeUndefined();

    await teardown(h);
  });

  it("returns 401 after the caller's session has ended", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    h.tokens.revoke(boot.sessionId);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "working", summary: "x" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });
});

describe("GET /sessions surfaces latest_status", () => {
  it("includes the latest status in the workspace session summary", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { state: "working", summary: "refactoring auth" },
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${boot.workspaceId}`,
    });
    expect(res.statusCode).toBe(200);
    const summaries = res.json() as Array<{
      session_id: string;
      latest_status?: { state: string; summary: string; updated_at: number };
    }>;
    const own = summaries.find((s) => s.session_id === boot.sessionId);
    expect(own).toBeDefined();
    expect(own!.latest_status).toBeDefined();
    expect(own!.latest_status!.state).toBe("working");
    expect(own!.latest_status!.summary).toBe("refactoring auth");
    expect(typeof own!.latest_status!.updated_at).toBe("number");

    await teardown(h);
  });

  it("omits latest_status when no status has been posted", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const res = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${boot.workspaceId}`,
    });
    expect(res.statusCode).toBe(200);
    const summaries = res.json() as Array<{
      session_id: string;
      latest_status?: unknown;
    }>;
    const own = summaries.find((s) => s.session_id === boot.sessionId);
    expect(own).toBeDefined();
    expect(own!.latest_status).toBeUndefined();

    await teardown(h);
  });
});
