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

interface KillRecord {
  readonly sessionId: string;
  readonly signal: NodeJS.Signals;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  killCalls: KillRecord[];
  repoPath: string;
}

function buildHarness(opts: { persistent: boolean }): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-end-session-"));
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: "manager", persistent: opts.persistent });
  workspaceRoles.setCeiling(ws.id, role.id, 1);
  const killCalls: KillRecord[] = [];
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const sessionId = req.sessionId;
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId,
      pid: 9000,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: (signal) => {
        killCalls.push({ sessionId, signal });
      },
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
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return { server, db, workspaces, roles, workspaceRoles, agents, sessions, killCalls, repoPath };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

async function spawn(h: Harness): Promise<{ session_id: string; agent_id: string }> {
  const wsId = h.db.query<{ id: string }, []>("SELECT id FROM workspaces").all()[0]!.id;
  const roleId = h.db.query<{ id: string }, []>("SELECT id FROM roles").all()[0]!.id;
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: roleId, prompt: "go" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { session_id: string; agent_id: string };
}

describe("POST /sessions/:id/end", () => {
  it("ends an active session by SIGTERM-ing the child, frees ceiling", async () => {
    const h = buildHarness({ persistent: false });
    const spawned = await spawn(h);
    expect(h.sessions.get(spawned.session_id)!.ended_at).toBeUndefined();

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ ok: true });

    const session = h.sessions.get(spawned.session_id);
    expect(typeof session!.ended_at).toBe("number");
    expect(h.killCalls).toEqual([
      { sessionId: spawned.session_id, signal: "SIGTERM" },
    ]);
    expect(h.agents.get(spawned.agent_id)).toBeNull();

    await teardown(h);
  });

  it("preserves a persistent agent when ending its session", async () => {
    const h = buildHarness({ persistent: true });
    const spawned = await spawn(h);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });

    expect(typeof h.sessions.get(spawned.session_id)!.ended_at).toBe("number");
    const agent = h.agents.get(spawned.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe(spawned.agent_id);

    await teardown(h);
  });

  it("is idempotent — second call still 200, ended_at unchanged", async () => {
    const h = buildHarness({ persistent: false });
    const spawned = await spawn(h);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });
    const endedAt = h.sessions.get(spawned.session_id)!.ended_at;

    const second = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });
    expect(second.statusCode).toBe(200);
    expect(h.sessions.get(spawned.session_id)!.ended_at).toBe(endedAt!);

    await teardown(h);
  });

  it("404 when the session does not exist", async () => {
    const h = buildHarness({ persistent: false });
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${randomUUID()}/end`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("session not found");
    await teardown(h);
  });

  it("subsequent /sessions/:id/prompt returns 404 (registry cleared)", async () => {
    const h = buildHarness({ persistent: false });
    const spawned = await spawn(h);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });

    const promptRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "follow-up" },
    });
    expect(promptRes.statusCode).toBe(404);
    await teardown(h);
  });
});
