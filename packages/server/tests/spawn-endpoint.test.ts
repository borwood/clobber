import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import type { AgentSpawner, AgentSpawnRequest } from "../src/server.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
}

function buildHarness(spawner: AgentSpawner): Harness {
  const db = createDatabase(":memory:");
  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    store,
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
  });
  return { server, db, workspaces, roles, workspaceRoles, agents, sessions };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
}

interface SeedOptions {
  readonly ceiling?: number;
  readonly persistent?: boolean;
  readonly permission_mode?: "bypassPermissions";
  readonly allowed_tools?: readonly string[];
}

function seed(h: Harness, opts: SeedOptions = {}) {
  const ws = h.workspaces.create({ name: "ws", repo_path: "/r" });
  const role = h.roles.create({
    name: "r",
    persistent: opts.persistent ?? false,
    ...(opts.permission_mode === undefined ? {} : { permission_mode: opts.permission_mode }),
    ...(opts.allowed_tools === undefined ? {} : { allowed_tools: [...opts.allowed_tools] }),
  });
  if (opts.ceiling !== undefined) h.workspaceRoles.setCeiling(ws.id, role.id, opts.ceiling);
  return { ws, role };
}

describe("POST /spawn", () => {
  it("creates agent + session, calls spawner with workspace cwd and role config", async () => {
    const calls: AgentSpawnRequest[] = [];
    let counter = 0;
    const h = buildHarness((req) => {
      calls.push(req);
      counter += 1;
      return { sessionId: `claude-session-${counter}`, pid: 9000 + counter, exited: new Promise<number | null>(() => {}) };
    });

    const ws = h.workspaces.create({ name: "ws", repo_path: "/repo/path" });
    const role = h.roles.create({
      name: "manager",
      persistent: true,
      permission_mode: "bypassPermissions",
      allowed_tools: ["Bash", "Read"],
    });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: role.id,
        prompt: "do the thing",
        label: "primary",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      agent_id: string;
      session_id: string;
      pid: number;
    };
    expect(body.session_id).toBe("claude-session-1");
    expect(body.pid).toBe(9001);
    expect(typeof body.agent_id).toBe("string");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "do the thing",
      cwd: "/repo/path",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
    });

    const agent = h.agents.get(body.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.workspace_id).toBe(ws.id);
    expect(agent!.role_id).toBe(role.id);
    expect(agent!.label).toBe("primary");

    const session = h.sessions.get(body.session_id);
    expect(session).not.toBeNull();
    expect(session!.agent_id).toBe(body.agent_id);
    expect(session!.pid).toBe(9001);
    expect(session!.ended_at).toBeUndefined();

    await teardown(h);
  });

  it("does not pass permission_mode or allowed_tools when role has none", async () => {
    const calls: AgentSpawnRequest[] = [];
    const h = buildHarness((req) => {
      calls.push(req);
      return { sessionId: "s1", pid: 1, exited: new Promise<number | null>(() => {}) };
    });
    const { ws, role } = seed(h, { ceiling: 1 });

    await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "hi" },
    });

    expect(calls[0]).toEqual({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "hi",
      cwd: "/r",
    });

    await teardown(h);
  });

  it("returns 404 when workspace_id is unknown", async () => {
    let invocations = 0;
    const h = buildHarness(() => {
      invocations += 1;
      return { sessionId: "x", pid: 0, exited: new Promise<number | null>(() => {}) };
    });
    const role = h.roles.create({ name: "r", persistent: false });

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        role_id: role.id,
        prompt: "hi",
      },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("workspace not found");
    expect(invocations).toBe(0);

    await teardown(h);
  });

  it("returns 404 when role_id is unknown", async () => {
    let invocations = 0;
    const h = buildHarness(() => {
      invocations += 1;
      return { sessionId: "x", pid: 0, exited: new Promise<number | null>(() => {}) };
    });
    const ws = h.workspaces.create({ name: "ws", repo_path: "/r" });
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: "00000000-0000-4000-8000-000000000000",
        prompt: "hi",
      },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("role not found");
    expect(invocations).toBe(0);

    await teardown(h);
  });

  it("returns 403 when no ceiling row exists (default 0)", async () => {
    let invocations = 0;
    const h = buildHarness(() => {
      invocations += 1;
      return { sessionId: "x", pid: 0, exited: new Promise<number | null>(() => {}) };
    });
    const { ws, role } = seed(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "hi" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; ceiling: number; active: number };
    expect(body.error).toBe("role at capacity");
    expect(body.ceiling).toBe(0);
    expect(body.active).toBe(0);
    expect(invocations).toBe(0);

    await teardown(h);
  });

  it("returns 403 when ceiling is met by active sessions", async () => {
    let counter = 0;
    const h = buildHarness(() => {
      counter += 1;
      return { sessionId: `s${counter}`, pid: counter, exited: new Promise<number | null>(() => {}) };
    });
    const { ws, role } = seed(h, { ceiling: 1 });
    const first = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "hi" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "hi again" },
    });
    expect(second.statusCode).toBe(403);
    const body = second.json() as { ceiling: number; active: number };
    expect(body.ceiling).toBe(1);
    expect(body.active).toBe(1);
    expect(counter).toBe(1);

    await teardown(h);
  });

  it("allows spawning again after a session ends", async () => {
    let counter = 0;
    const h = buildHarness(() => {
      counter += 1;
      return { sessionId: `s${counter}`, pid: counter, exited: new Promise<number | null>(() => {}) };
    });
    const { ws, role } = seed(h, { ceiling: 1 });
    const first = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "hi" },
    });
    const firstId = (first.json() as { session_id: string }).session_id;
    h.sessions.markEnded(firstId);

    const second = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "again" },
    });
    expect(second.statusCode).toBe(200);
    expect(counter).toBe(2);

    await teardown(h);
  });

});
