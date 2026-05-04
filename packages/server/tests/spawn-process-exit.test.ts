import { describe, it, expect } from "bun:test";
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
import type { AgentSpawner } from "../src/types.ts";

interface DeferredSpawner {
  readonly spawner: AgentSpawner;
  exit(sessionId: string, code: number | null): Promise<void>;
  readonly sessions: readonly string[];
}

function deferredExitSpawner(): DeferredSpawner {
  const resolvers = new Map<string, (code: number | null) => void>();
  const sessions: string[] = [];
  let counter = 0;
  const spawner: AgentSpawner = (req) => {
    counter += 1;
    if (req.sessionId === undefined) throw new Error("test stub expects sessionId from spawn route");
    const sessionId = req.sessionId;
    sessions.push(sessionId);
    const exited = new Promise<number | null>((resolve) => {
      resolvers.set(sessionId, resolve);
    });
    const stdin = new PassThrough();
    stdin.resume();
    return { sessionId, pid: 1000 + counter, exited, stdin };
  };
  async function exit(sessionId: string, code: number | null): Promise<void> {
    const resolve = resolvers.get(sessionId);
    if (resolve === undefined) {
      throw new Error(`deferredExitSpawner: no live session ${sessionId}`);
    }
    resolve(code);
    resolvers.delete(sessionId);
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return { spawner, exit, sessions };
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  spawnControl: DeferredSpawner;
  repoPaths: string[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const spawnControl = deferredExitSpawner();
  const server = createServer({
    store,
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    spawner: spawnControl.spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return {
    server,
    db,
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    spawnControl,
    repoPaths: [],
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  for (const p of h.repoPaths) rmSync(p, { recursive: true, force: true });
}

interface SeedOpts {
  readonly persistent: boolean;
  readonly ceiling?: number;
}

function seedWorkspaceRole(h: Harness, opts: SeedOpts) {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-process-exit-"));
  h.repoPaths.push(repoPath);
  const ws = h.workspaces.create({ name: `ws-${Math.random()}`, repo_path: repoPath });
  const role = h.roles.create({ name: "manager", persistent: opts.persistent });
  h.workspaceRoles.setCeiling(ws.id, role.id, opts.ceiling === undefined ? 1 : opts.ceiling);
  return { ws, role };
}

async function spawn(
  h: Harness,
  ws: { id: string },
  role: { id: string },
  prompt = "go",
): Promise<{ agent_id: string; session_id: string; pid: number }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { agent_id: string; session_id: string; pid: number };
}

describe("process-exit reaper (issue #5)", () => {
  it("ephemeral agent: child exit marks session ended and deletes the agent", async () => {
    const h = buildHarness();
    const { ws, role } = seedWorkspaceRole(h, { persistent: false });

    const spawned = await spawn(h, ws, role);
    expect(h.sessions.get(spawned.session_id)!.ended_at).toBeUndefined();
    expect(h.agents.get(spawned.agent_id)).not.toBeNull();

    await h.spawnControl.exit(spawned.session_id, 0);

    const session = h.sessions.get(spawned.session_id);
    expect(session).not.toBeNull();
    expect(typeof session!.ended_at).toBe("number");
    expect(h.agents.get(spawned.agent_id)).toBeNull();

    await teardown(h);
  });

  it("persistent agent: child exit marks session ended but preserves the agent row", async () => {
    const h = buildHarness();
    const { ws, role } = seedWorkspaceRole(h, { persistent: true });

    const spawned = await spawn(h, ws, role);

    await h.spawnControl.exit(spawned.session_id, 0);

    const session = h.sessions.get(spawned.session_id);
    expect(typeof session!.ended_at).toBe("number");
    const agent = h.agents.get(spawned.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe(spawned.agent_id);

    await teardown(h);
  });

  it("non-zero exit code is also treated as session end", async () => {
    const h = buildHarness();
    const { ws, role } = seedWorkspaceRole(h, { persistent: false });

    const spawned = await spawn(h, ws, role);
    await h.spawnControl.exit(spawned.session_id, 137);

    expect(typeof h.sessions.get(spawned.session_id)!.ended_at).toBe("number");
    expect(h.agents.get(spawned.agent_id)).toBeNull();

    await teardown(h);
  });

  it("null exit code (signal) is also treated as session end", async () => {
    const h = buildHarness();
    const { ws, role } = seedWorkspaceRole(h, { persistent: false });

    const spawned = await spawn(h, ws, role);
    await h.spawnControl.exit(spawned.session_id, null);

    expect(typeof h.sessions.get(spawned.session_id)!.ended_at).toBe("number");
    expect(h.agents.get(spawned.agent_id)).toBeNull();

    await teardown(h);
  });

  it("frees ceiling capacity after exit so a new spawn fits (the original bug)", async () => {
    const h = buildHarness();
    const { ws, role } = seedWorkspaceRole(h, { persistent: false, ceiling: 1 });

    const first = await spawn(h, ws, role, "first");

    const blocked = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "second" },
    });
    expect(blocked.statusCode).toBe(403);

    await h.spawnControl.exit(first.session_id, 0);

    const second = await spawn(h, ws, role, "second");
    expect(second.session_id).not.toBe(first.session_id);

    await teardown(h);
  });

  it("idempotent: process exit then SessionEnd hook leaves a single ended session", async () => {
    const h = buildHarness();
    const { ws, role } = seedWorkspaceRole(h, { persistent: false });

    const spawned = await spawn(h, ws, role);

    await h.spawnControl.exit(spawned.session_id, 0);
    const endedAtAfterExit = h.sessions.get(spawned.session_id)!.ended_at;
    expect(typeof endedAtAfterExit).toBe("number");

    const hookRes = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: spawned.session_id,
        transcript_path: "/tmp/t.jsonl",
        cwd: "/r",
        permission_mode: "default",
        hook_event_name: "SessionEnd",
      },
    });
    expect(hookRes.statusCode).toBe(200);

    expect(h.sessions.get(spawned.session_id)!.ended_at).toBe(endedAtAfterExit!);
    expect(h.agents.get(spawned.agent_id)).toBeNull();

    await teardown(h);
  });

  it("idempotent: SessionEnd hook then process exit leaves a single ended session", async () => {
    const h = buildHarness();
    const { ws, role } = seedWorkspaceRole(h, { persistent: false });

    const spawned = await spawn(h, ws, role);

    const hookRes = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: spawned.session_id,
        transcript_path: "/tmp/t.jsonl",
        cwd: "/r",
        permission_mode: "default",
        hook_event_name: "SessionEnd",
      },
    });
    expect(hookRes.statusCode).toBe(200);
    const endedAtAfterHook = h.sessions.get(spawned.session_id)!.ended_at;
    expect(typeof endedAtAfterHook).toBe("number");
    expect(h.agents.get(spawned.agent_id)).toBeNull();

    await h.spawnControl.exit(spawned.session_id, 0);

    expect(h.sessions.get(spawned.session_id)!.ended_at).toBe(endedAtAfterHook!);
    expect(h.agents.get(spawned.agent_id)).toBeNull();

    await teardown(h);
  });
});
