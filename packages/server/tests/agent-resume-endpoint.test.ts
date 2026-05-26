import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import type { AgentSpawnRequest } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  roles: ReturnType<typeof createRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  workspaceId: string;
  managerToken: string;
  workerToken: string;
  workerRoleId: string;
  resumeRequests: AgentSpawnRequest[];
  repoPath: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(): Harness {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-resume-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const ws = workspaces.create({ name: `ws-${randomUUID()}`, repo_path: repoPath });

  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager");
  const workerRole = roles.findInWorkspace(ws.id, "worker");
  if (managerRole === null || workerRole === null) throw new Error("roles not seeded");

  const resumeRequests: AgentSpawnRequest[] = [];
  let pidCounter = 6000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.resume === true) resumeRequests.push(req);
    return {
      sessionId: req.sessionId ?? randomUUID(),
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };

  function provisionSession(roleId: string): string {
    const agent = agents.create({ workspace_id: ws.id, role_id: roleId });
    const sessionId = randomUUID();
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleId,
      pid: 1,
    });
    return tokens.mint(sessionId);
  }

  const managerToken = provisionSession(managerRole.id);
  const workerToken = provisionSession(workerRole.id);

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
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });

  return {
    server,
    db,
    workspaces,
    workspaceRoles,
    roles,
    agents,
    sessions,
    tokens,
    workspaceId: ws.id,
    managerToken,
    workerToken,
    workerRoleId: workerRole.id,
    resumeRequests,
    repoPath,
  };
}

// Create an ended, resumable worker session (agent survives end; provider
// thread id present so the runtime can be resumed).
function seedEndedWorkerSession(h: Harness, opts?: { roleVersionId?: string }): {
  sessionId: string;
  agentId: string;
} {
  const agent = h.agents.create({ workspace_id: h.workspaceId, role_id: h.workerRoleId });
  const role = h.roles.get(h.workerRoleId)!;
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: h.workspaceId,
    role_id: h.workerRoleId,
    role_version_id: opts?.roleVersionId ?? role.current_version_id,
    provider_thread_id: sessionId,
    pid: 4242,
  });
  h.sessions.markEnded(sessionId);
  return { sessionId, agentId: agent.id };
}

let h: Harness;
beforeEach(() => {
  h = buildHarness();
});
afterEach(async () => {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
});

describe("POST /agent/sessions/:id/resume", () => {
  it("manager revives an ended session — clears ended_at, resumes the thread", async () => {
    const ended = seedEndedWorkerSession(h);
    const pinned = h.sessions.get(ended.sessionId)!.role_version_id;

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
      payload: { prompt: "CI is green, open the PR" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; pid: number };
    expect(body.session_id).toBe(ended.sessionId);
    expect(body.pid).toBeGreaterThan(0);

    const after = h.sessions.get(ended.sessionId)!;
    expect(after.ended_at).toBeUndefined();
    // Pinned role version preserved across resume.
    expect(after.role_version_id).toBe(pinned);

    // Resumed against the existing provider thread, not a fresh spawn.
    expect(h.resumeRequests.length).toBe(1);
    expect(h.resumeRequests[0]!.providerThreadId).toBe(ended.sessionId);
  });

  it("a prompted resume forwards exactly the prompt to the runtime", async () => {
    const ended = seedEndedWorkerSession(h);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
      payload: { prompt: "ship it" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.resumeRequests.length).toBe(1);
    // The seeded workspace uses the noop boot-context provider, so the resume
    // prompt flows through unwrapped — exactly the injected user turn.
    expect(h.resumeRequests[0]!.prompt).toBe("ship it");
  });

  it("a bare resume composes no user message for the runtime", async () => {
    const ended = seedEndedWorkerSession(h);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(h.resumeRequests.length).toBe(1);
    // No prompt + noop boot context => nothing to inject. The `?? ""` default
    // that used to fabricate an empty user turn (#227) is gone.
    expect(h.resumeRequests[0]!.prompt).toBeUndefined();
  });

  it("a worker is denied (403) — workers don't bring sessions back", async () => {
    const ended = seedEndedWorkerSession(h);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/'resume'/);
    expect(body.error).toMatch(/'worker'/);
  });

  it("returns 404 for an unknown session id", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${randomUUID()}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the target belongs to another workspace", async () => {
    const otherRepo = mkdtempSync(join(tmpdir(), "clobber-resume-other-"));
    const otherWs = h.workspaces.create({ name: `ws-${randomUUID()}`, repo_path: otherRepo });
    seedWorkspaceRoles(h.db, otherWs.id);
    const otherWorker = h.roles.findInWorkspace(otherWs.id, "worker")!;
    const agent = h.agents.create({ workspace_id: otherWs.id, role_id: otherWorker.id });
    const sessionId = randomUUID();
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: otherWs.id,
      role_id: otherWorker.id,
      provider_thread_id: sessionId,
      pid: 7,
    });
    h.sessions.markEnded(sessionId);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
    rmSync(otherRepo, { recursive: true, force: true });
  });

  it("returns 403 when reviving would exceed the role ceiling", async () => {
    h.workspaceRoles.setCeiling(h.workspaceId, h.workerRoleId, 1);
    // One active worker session occupies the only slot.
    const activeAgent = h.agents.create({
      workspace_id: h.workspaceId,
      role_id: h.workerRoleId,
    });
    h.sessions.create({
      id: randomUUID(),
      agent_id: activeAgent.id,
      workspace_id: h.workspaceId,
      role_id: h.workerRoleId,
      pid: 9,
    });
    const ended = seedEndedWorkerSession(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/capacity/);
    // Still ended — the failed resume did not re-occupy the slot.
    expect(h.sessions.get(ended.sessionId)!.ended_at).toBeDefined();
  });
});
