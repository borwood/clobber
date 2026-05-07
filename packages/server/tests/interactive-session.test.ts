import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serializeUserMessage } from "@clobber/runtime";
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
import type { AgentSpawner } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";

interface StubAgent {
  readonly sessionId: string;
  readonly pid: number;
  readonly writes: string[];
  exit(code: number | null): Promise<void>;
}

interface SpawnControl {
  readonly spawner: AgentSpawner;
  readonly agents: StubAgent[];
}

function controlledSpawner(): SpawnControl {
  const agents: StubAgent[] = [];
  const resolvers = new Map<string, (code: number | null) => void>();
  let counter = 0;

  const spawner: AgentSpawner = (req) => {
    counter += 1;
    if (req.sessionId === undefined) throw new Error("test stub expects sessionId from spawn route");
    const sessionId = req.sessionId;
    const stdin = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => {
      writes.push(chunk.toString());
    });
    const exited = new Promise<number | null>((resolve) => {
      resolvers.set(sessionId, resolve);
    });
    const stub: StubAgent = {
      sessionId,
      pid: 2000 + counter,
      writes,
      async exit(code) {
        const r = resolvers.get(sessionId);
        if (r === undefined) throw new Error(`no live spawn for ${sessionId}`);
        r(code);
        resolvers.delete(sessionId);
        await new Promise<void>((res) => setTimeout(res, 0));
      },
    };
    agents.push(stub);
    return { sessionId, pid: stub.pid, exited, stdin, kill: () => {} };
  };

  return { spawner, agents };
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  control: SpawnControl;
  repoPaths: string[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agentsStore = createAgentStore(db);
  const sessions = createSessionStore(db);
  const control = controlledSpawner();
  const server = createServer({
    db,
    store,
    workspaces,
    roles,

    roleVersions,
    workspaceRoles,
    agents: agentsStore,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: control.spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
  });
  return {
    server,
    db,
    workspaces,
    roles,
    workspaceRoles,
    agents: agentsStore,
    sessions,
    control,
    repoPaths: [],
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  for (const p of h.repoPaths) rmSync(p, { recursive: true, force: true });
}

interface Spawned {
  agent_id: string;
  session_id: string;
  pid: number;
}

async function seedAndSpawn(h: Harness, persistent = true): Promise<Spawned> {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-interactive-"));
  h.repoPaths.push(repoPath);
  const ws = h.workspaces.create({ name: `ws-${Math.random()}`, repo_path: repoPath });
  const role = h.roles.create({ name: "manager", persistent });
  h.workspaceRoles.setCeiling(ws.id, role.id, 1);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "initial", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Spawned;
}

function stopHook(sessionId: string) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/r",
    permission_mode: "default" as const,
    hook_event_name: "Stop" as const,
  };
}

async function fireStop(h: Harness, sessionId: string): Promise<void> {
  const res = await h.server.inject({
    method: "POST",
    url: "/hook",
    payload: stopHook(sessionId),
  });
  expect(res.statusCode).toBe(200);
}

describe("POST /sessions/:id/prompt — interactive sessions (issue #8)", () => {
  it("after Stop hook clears busy, prompt is written to the live child's stdin", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "hello again" },
    });
    expect(res.statusCode).toBe(200);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    expect(stub).toBeDefined();
    expect(stub!.writes.join("")).toBe(serializeUserMessage("hello again"));

    await teardown(h);
  });

  it("returns 409 when the agent is busy (initial turn in progress, no Stop yet)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "too soon" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("agent busy");

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    expect(stub!.writes.join("")).toBe("");

    await teardown(h);
  });

  it("two prompts back-to-back: first 200, second 409 until next Stop", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const first = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "one" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "two" },
    });
    expect(second.statusCode).toBe(409);

    await fireStop(h, spawned.session_id);
    const third = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "three" },
    });
    expect(third.statusCode).toBe(200);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    expect(stub!.writes.join("")).toBe(
      serializeUserMessage("one") + serializeUserMessage("three"),
    );

    await teardown(h);
  });

  it("returns 404 for an unknown session id", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/00000000-0000-4000-8000-deadbeef0001/prompt`,
      payload: { prompt: "anything" },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 410 'session ended' once the child has exited (#12)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id)!;
    await stub.exit(0);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "after death" },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe("session ended");

    await teardown(h);
  });

  it("returns 410 'session ended' for a session whose row has ended_at, regardless of registry state (#12)", async () => {
    // Boot-reaper scenario: ended_at is set but the in-memory registry was
    // never populated (e.g. server restarted, the row is the orphan). The
    // prompt route must read the row, not just the registry, to decide
    // between 404 (never existed) and 410 (existed, now done).
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);
    h.sessions.markEnded(spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "after death" },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe("session ended");

    await teardown(h);
  });

  it("rejects empty prompt with 400", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "" },
    });
    expect(res.statusCode).toBe(400);
    await teardown(h);
  });

  it("multi-line prompts are accepted (JSON-encoded as a single turn)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const multiline = "line one\nline two";
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: multiline },
    });
    expect(res.statusCode).toBe(200);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    expect(stub!.writes.join("")).toBe(serializeUserMessage(multiline));
    await teardown(h);
  });
});
