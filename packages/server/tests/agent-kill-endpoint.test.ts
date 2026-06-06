import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
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
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";

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
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  killCalls: KillRecord[];
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
  const killCalls: KillRecord[] = [];
  let pidCounter = 5000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const sessionId = req.sessionId;
    return {
      sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
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
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens, killCalls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;
let otherRepoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-kill-"));
  otherRepoPath = mkdtempSync(join(tmpdir(), "clobber-agent-kill-other-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(otherRepoPath, { recursive: true, force: true });
});

interface Booted {
  workspaceId: string;
  managerSessionId: string;
  managerToken: string;
  managerRoleId: string;
}

async function bootManager(h: Harness, repo: string): Promise<Booted> {
  const ws = h.workspaces.create({ name: `ws-${repo}`, repo_path: repo });
  const managerRole = h.roles.findByName("manager") ??
    h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, managerRole.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`boot failed: ${res.body}`);
  const body = res.json() as { session_id: string };
  const token = h.tokens.mint(body.session_id);
  return {
    workspaceId: ws.id,
    managerSessionId: body.session_id,
    managerToken: token,
    managerRoleId: managerRole.id,
  };
}

async function spawnChild(h: Harness, callerToken: string): Promise<{
  sessionId: string;
  agentId: string;
}> {
  const res = await h.server.inject({
    method: "POST",
    url: "/agent/spawn",
    headers: { authorization: `Bearer ${callerToken}` },
    payload: { role: "manager", prompt: "do work", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn failed: ${res.body}`);
  const body = res.json() as { session_id: string; agent_id: string };
  return { sessionId: body.session_id, agentId: body.agent_id };
}

describe("POST /agent/sessions/:id/kill", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/sessions/abc/kill",
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 for a revoked token", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    h.tokens.revoke(boot.managerSessionId);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${boot.managerSessionId}/kill`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 404 for a missing session id", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/sessions/does-not-exist/kill",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 404 when target session belongs to a different workspace", async () => {
    const h = buildHarness();
    const bootA = await bootManager(h, repoPath);
    const bootB = await bootManager(h, otherRepoPath);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${bootB.managerSessionId}/kill`,
      headers: { authorization: `Bearer ${bootA.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(h.killCalls).toEqual([]);
    await teardown(h);
  });

  it("terminates a live child session and ends it", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    const child = await spawnChild(h, boot.managerToken);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${child.sessionId}/kill`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as { ok: boolean }).toEqual({ ok: true });

    expect(h.killCalls).toEqual([{ sessionId: child.sessionId, signal: "SIGTERM" }]);

    const session = h.sessions.get(child.sessionId);
    expect(session).not.toBeNull();
    expect(session!.ended_at).toBeDefined();

    const list = await h.server.inject({
      method: "GET",
      url: "/agent/agents",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    const body = list.json() as { agents: Array<{ session_id: string }> };
    expect(body.agents.map((a) => a.session_id)).not.toContain(child.sessionId);

    await teardown(h);
  });

  it("is idempotent when the session has already ended", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    const child = await spawnChild(h, boot.managerToken);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${child.sessionId}/end`,
    });

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${child.sessionId}/kill`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(h.killCalls).toEqual([
      { sessionId: child.sessionId, signal: "SIGTERM" },
    ]);
    await teardown(h);
  });
});
