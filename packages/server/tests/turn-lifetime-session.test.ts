import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  claudeRuntimeProvider,
  type RuntimeProvider,
  type RuntimeSpawnRequest,
} from "@clobber/runtime";
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
import type { AgentSpawner } from "../src/types.ts";

interface SpawnRecord {
  readonly req: RuntimeSpawnRequest;
  exit(code: number | null): Promise<void>;
}

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly records: SpawnRecord[];
  readonly repoPath: string;
}

function turnProvider(opts: {
  readonly initialThreadId?: (sessionId: string) => string | undefined;
} = {}): RuntimeProvider {
  return {
    ...claudeRuntimeProvider,
    id: "codex-test",
    capabilities: {
      processLifetime: "turn",
      livePromptInjection: false,
      interrupt: false,
      resume: true,
    },
    initialProviderThreadId(sessionId) {
      return opts.initialThreadId === undefined
        ? `thread-${sessionId}`
        : opts.initialThreadId(sessionId);
    },
    buildResumeRequest(opts) {
      return {
        ...this.buildSpawnRequest(opts),
        resume: true,
        providerThreadId: opts.providerThreadId,
      };
    },
  };
}

function buildHarness(
  runtimeProvider: RuntimeProvider,
  spawnerOverride?: (req: RuntimeSpawnRequest) => ReturnType<AgentSpawner>,
): Harness {
  const db = createDatabase(":memory:");
  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionTokens = createSessionTokenStore(db);
  const records: SpawnRecord[] = [];
  let counter = 0;
  const spawner: AgentSpawner = (req) => {
    if (spawnerOverride !== undefined) return spawnerOverride(req);
    counter += 1;
    const stdin = new PassThrough();
    stdin.resume();
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    records.push({
      req,
      async exit(code) {
        resolveExit(code);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    });
    return {
      sessionId: req.sessionId,
      pid: 4000 + counter,
      exited,
      stdin,
      kill: () => {},
    };
  };
  const server = createServer({
    db,
    store,
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    runtimeProvider,
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
  });
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-turn-runtime-"));
  return { server, db, workspaces, roles, workspaceRoles, sessions, records, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

async function spawn(h: Harness): Promise<{ session_id: string; pid: number }> {
  const ws = h.workspaces.create({ name: `ws-${Math.random()}`, repo_path: h.repoPath });
  const role = h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, role.id, 1);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: {
      workspace_id: ws.id,
      role_id: role.id,
      prompt: "initial",
      label: "codex-like",
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { session_id: string; pid: number };
}

describe("turn-lifetime runtime sessions (#103)", () => {
  it("returns 409 while a turn process is still live", async () => {
    const h = buildHarness(turnProvider());
    const first = await spawn(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${first.session_id}/prompt`,
      payload: { prompt: "too soon" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json() as unknown).toEqual({ error: "agent busy" });
    expect(h.records).toHaveLength(1);

    await teardown(h);
  });

  it("keeps a cleanly completed turn resumable and starts a resume process on prompt", async () => {
    const h = buildHarness(turnProvider());
    const first = await spawn(h);
    expect(h.sessions.get(first.session_id)!.provider_thread_id).toBe(
      `thread-${first.session_id}`,
    );

    await h.records[0]!.exit(0);
    expect(h.sessions.get(first.session_id)!.ended_at).toBeUndefined();

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${first.session_id}/prompt`,
      payload: { prompt: "next turn" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ ok: true, pid: 4002 });
    expect(h.records).toHaveLength(2);
    expect(h.records[1]!.req).toMatchObject({
      sessionId: first.session_id,
      providerThreadId: `thread-${first.session_id}`,
      resume: true,
      prompt: expect.stringContaining("next turn"),
    });
    expect(h.sessions.get(first.session_id)!.pid).toBe(4002);

    await teardown(h);
  });

  it("returns 410 when prompting an ended turn-lifetime session", async () => {
    const h = buildHarness(turnProvider());
    const first = await spawn(h);
    await h.records[0]!.exit(1);
    expect(h.sessions.get(first.session_id)!.ended_at).toBeDefined();

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${first.session_id}/prompt`,
      payload: { prompt: "next turn" },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json() as unknown).toEqual({ error: "session ended" });
    expect(h.records).toHaveLength(1);

    await teardown(h);
  });

  it("returns 409 when a turn-lifetime session has no provider thread id", async () => {
    const h = buildHarness(turnProvider({ initialThreadId: () => undefined }));
    const first = await spawn(h);
    await h.records[0]!.exit(0);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${first.session_id}/prompt`,
      payload: { prompt: "next turn" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json() as unknown).toEqual({ error: "runtime provider thread unavailable" });
    expect(h.records).toHaveLength(1);

    await teardown(h);
  });

  it("ends the session with 410 when the runtime reports the provider thread is gone", async () => {
    const h = buildHarness(turnProvider(), (req) => {
      if (req.resume === true) throw new Error("provider thread not found");
      const stdin = new PassThrough();
      stdin.resume();
      return {
        sessionId: req.sessionId,
        pid: 5001,
        exited: Promise.resolve(0),
        stdin,
        kill: () => {},
      };
    });
    const first = await spawn(h);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${first.session_id}/prompt`,
      payload: { prompt: "next turn" },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json() as unknown).toEqual({
      error: "runtime provider thread not found",
      detail: "provider thread not found",
    });
    expect(h.sessions.get(first.session_id)!.ended_at).toBeDefined();

    await teardown(h);
  });

  it("returns 502 when the runtime cannot start the resume process for an unknown reason", async () => {
    const h = buildHarness(turnProvider(), (req) => {
      if (req.resume === true) throw new Error("codex unavailable");
      const stdin = new PassThrough();
      stdin.resume();
      return {
        sessionId: req.sessionId,
        pid: 5001,
        exited: Promise.resolve(0),
        stdin,
        kill: () => {},
      };
    });
    const first = await spawn(h);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${first.session_id}/prompt`,
      payload: { prompt: "next turn" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json() as unknown).toEqual({
      error: "runtime resume failed",
      detail: "codex unavailable",
    });
    expect(h.sessions.get(first.session_id)!.ended_at).toBeUndefined();

    await teardown(h);
  });
});
