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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import type {
  AgentSpawner,
  AgentSpawnRequest,
  SpawnedAgentInfo,
} from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  calls: AgentSpawnRequest[];
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
  const calls: AgentSpawnRequest[] = [];
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    calls.push(req);
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 4321,
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
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface BootedManager {
  workspaceId: string;
  managerSessionId: string;
  managerToken: string;
  managerRoleId: string;
  ghostRoleId: string;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-spawn-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function bootManager(h: Harness): Promise<BootedManager> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const managerRole = h.roles.create({ name: "manager", persistent: true });
  const ghostRole = h.roles.create({ name: "ghost-role", persistent: false });
  h.workspaceRoles.setCeiling(ws.id, managerRole.id, 2);
  h.workspaceRoles.setCeiling(ws.id, ghostRole.id, 5);

  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string };
  const token = h.tokens.mint(body.session_id);
  return {
    workspaceId: ws.id,
    managerSessionId: body.session_id,
    managerToken: token,
    managerRoleId: managerRole.id,
    ghostRoleId: ghostRole.id,
  };
}

describe("POST /agent/spawn", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: { role: "worker", prompt: "do x", label: "boot" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 for an unknown bearer token", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: { role: "worker", prompt: "do x", label: "boot" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 400 when body is malformed", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: 42, label: "boot" },
    });
    expect(res.statusCode).toBe(400);
    await teardown(h);
  });

  it("returns 404 when role name is unknown", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "nonexistent", prompt: "do x", label: "boot" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/role/i);
    await teardown(h);
  });

  it("spawns into the caller's workspace and returns session info", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const callsBefore = h.calls.length;
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "audit auth.ts", label: "auditor" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      session_id: string;
      agent_id: string;
      pid: number;
    };
    expect(typeof body.session_id).toBe("string");
    expect(typeof body.agent_id).toBe("string");
    expect(body.pid).toBe(4321);

    expect(h.calls.length).toBe(callsBefore + 1);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.cwd).toBe(repoPath);
    // Manager is persistent → office-context prefix is prepended; user prompt is the suffix.
    expect(call.prompt!.endsWith("audit auth.ts")).toBe(true);

    const session = h.sessions.get(body.session_id);
    expect(session).not.toBeNull();
    expect(session!.workspace_id).toBe(boot.workspaceId);
    expect(session!.role_id).toBe(boot.managerRoleId);

    await teardown(h);
  });

  it("returns 403 when the role is at its workspace ceiling", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    h.workspaceRoles.setCeiling(boot.workspaceId, boot.managerRoleId, 0);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "x", label: "boot" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/capacity/i);
    await teardown(h);
  });

  it("returns 422 when the role exists but has no current version (#21)", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const callsBefore = h.calls.length;
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "ghost-role", prompt: "x", label: "boot" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; role: string };
    expect(body.error).toMatch(/current version/i);
    expect(body.role).toBe("ghost-role");
    expect(h.calls.length).toBe(callsBefore);
    expect(h.sessions.countActive(boot.workspaceId, boot.ghostRoleId)).toBe(0);

    await teardown(h);
  });

  it("returns 401 after the caller's session has ended", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    h.tokens.revoke(boot.managerSessionId);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "x", label: "x" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 400 'label is required' when label is missing (#36)", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const callsBefore = h.calls.length;
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "audit auth.ts" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("label is required");
    expect(h.calls.length).toBe(callsBefore);
    await teardown(h);
  });

  it("returns 400 'label is required' when label is empty/whitespace (#36)", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const callsBefore = h.calls.length;
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "audit auth.ts", label: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("label is required");
    expect(h.calls.length).toBe(callsBefore);
    await teardown(h);
  });

  it("forwards the role's default effort to the spawner when no override is supplied", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true, effort: "xhigh" });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);
    const boot = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
    });
    expect(boot.statusCode).toBe(200);
    const bootBody = boot.json() as { session_id: string };
    const token = h.tokens.mint(bootBody.session_id);

    const callsBefore = h.calls.length;
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "manager", prompt: "design pass on auth.ts", label: "design" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls.length).toBe(callsBefore + 1);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.effort).toBe("xhigh");
    await teardown(h);
  });

  it("per-spawn effort override beats the role's default", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true, effort: "low" });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);
    const boot = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
    });
    expect(boot.statusCode).toBe(200);
    const bootBody = boot.json() as { session_id: string };
    const token = h.tokens.mint(bootBody.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        role: "manager",
        prompt: "this one needs max depth",
        label: "deep-dive",
        effort: "max",
      },
    });
    expect(res.statusCode).toBe(200);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.effort).toBe("max");
    await teardown(h);
  });

  it("omits effort entirely when role default and override are both unset (claude default applies)", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "do x", label: "no-effort" },
    });
    expect(res.statusCode).toBe(200);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.effort).toBeUndefined();
    await teardown(h);
  });

  it("forwards the role's default model to the spawner when no override is supplied", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true, model: "opus" });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);
    const boot = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
    });
    expect(boot.statusCode).toBe(200);
    const bootBody = boot.json() as { session_id: string };
    const token = h.tokens.mint(bootBody.session_id);

    const callsBefore = h.calls.length;
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "manager", prompt: "design pass on auth.ts", label: "design" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls.length).toBe(callsBefore + 1);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.model).toBe("opus");
    await teardown(h);
  });

  it("per-spawn model override beats the role's default", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true, model: "opus" });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);
    const boot = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
    });
    expect(boot.statusCode).toBe(200);
    const bootBody = boot.json() as { session_id: string };
    const token = h.tokens.mint(bootBody.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        role: "manager",
        prompt: "this lane is cheap; route to sonnet",
        label: "cheap-lane",
        model: "sonnet",
      },
    });
    expect(res.statusCode).toBe(200);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.model).toBe("sonnet");
    await teardown(h);
  });

  it("omits model entirely when role default and override are both unset (claude default applies)", async () => {
    const h = buildHarness();
    const boot = await bootManager(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "do x", label: "no-model" },
    });
    expect(res.statusCode).toBe(200);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.model).toBeUndefined();
    await teardown(h);
  });
});
