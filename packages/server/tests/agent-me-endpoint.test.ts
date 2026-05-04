import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { SpawnedAgentInfo } from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaceId: string;
  roleId: string;
  roleName: string;
  tokens: ReturnType<typeof createSessionTokenStore>;
  repoPath: string;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-me-"));
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: "manager", persistent: false });
  workspaceRoles.setCeiling(ws.id, role.id, 1);
  const stub: SpawnedAgentInfo = {
    sessionId: "stub",
    pid: 9000,
    exited: new Promise<number | null>(() => {}),
    stdin: makeStdin(),
    kill: () => {},
  };
  const server = createServer({
    store: createEventStore(db),
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => ({ ...stub, sessionId: randomUUID() }),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return {
    server,
    db,
    workspaceId: ws.id,
    roleId: role.id,
    roleName: role.name,
    tokens,
    repoPath,
  };
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

async function spawnAndMint(h: Harness): Promise<{ sessionId: string; token: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: h.workspaceId, role_id: h.roleId, prompt: "go" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string };
  const token = h.tokens.mint(body.session_id);
  return { sessionId: body.session_id, token };
}

describe("GET /agent/me", () => {
  it("returns session + workspace + role for a valid token", async () => {
    const h = buildHarness();
    const { sessionId, token } = await spawnAndMint(h);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      session_id: string;
      workspace_id: string;
      role: { id: string; name: string };
      started_at: number;
    };
    expect(body.session_id).toBe(sessionId);
    expect(body.workspace_id).toBe(h.workspaceId);
    expect(body.role.id).toBe(h.roleId);
    expect(body.role.name).toBe(h.roleName);
    expect(typeof body.started_at).toBe("number");

    await teardown(h);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const h = buildHarness();
    const res = await h.server.inject({ method: "GET", url: "/agent/me" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toMatch(/auth/i);
    await teardown(h);
  });

  it("returns 401 for a malformed Authorization header", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: "NotBearer something" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 for an unknown token", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 after the token has been revoked", async () => {
    const h = buildHarness();
    const { sessionId, token } = await spawnAndMint(h);
    h.tokens.revoke(sessionId);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });
});

describe("SessionTokenStore", () => {
  it("mints a fresh token per session and looks it up", () => {
    const db = createDatabase(":memory:");
    const sessions = createSessionStore(db);
    const tokens = createSessionTokenStore(db);
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const ws = workspaces.create({ name: "w", repo_path: "/r" });
    const role = roles.create({ name: "r", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id });
    const session = sessions.create({
      id: randomUUID(),
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    const token = tokens.mint(session.id);
    expect(token.length).toBeGreaterThan(20);
    const looked = tokens.lookup(token);
    expect(looked?.session_id).toBe(session.id);

    db.close();
  });

  it("re-minting for the same session replaces the old token", () => {
    const db = createDatabase(":memory:");
    const sessions = createSessionStore(db);
    const tokens = createSessionTokenStore(db);
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const ws = workspaces.create({ name: "w", repo_path: "/r" });
    const role = roles.create({ name: "r", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id });
    const session = sessions.create({
      id: randomUUID(),
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    const a = tokens.mint(session.id);
    const b = tokens.mint(session.id);
    expect(a).not.toBe(b);
    expect(tokens.lookup(a)).toBeNull();
    expect(tokens.lookup(b)?.session_id).toBe(session.id);

    db.close();
  });

  it("revoke removes the token", () => {
    const db = createDatabase(":memory:");
    const sessions = createSessionStore(db);
    const tokens = createSessionTokenStore(db);
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const ws = workspaces.create({ name: "w", repo_path: "/r" });
    const role = roles.create({ name: "r", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id });
    const session = sessions.create({
      id: randomUUID(),
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    const token = tokens.mint(session.id);
    tokens.revoke(session.id);
    expect(tokens.lookup(token)).toBeNull();

    db.close();
  });
});
