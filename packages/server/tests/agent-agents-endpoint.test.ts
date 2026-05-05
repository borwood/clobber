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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
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
  let pidCounter = 5000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    calls.push(req);
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
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
  
    dispatches: createTriggerDispatchStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;
let otherRepoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-agents-list-"));
  otherRepoPath = mkdtempSync(join(tmpdir(), "clobber-agents-list-other-"));
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

describe("GET /agent/agents", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const res = await h.server.inject({ method: "GET", url: "/agent/agents" });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 for a revoked token", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    h.tokens.revoke(boot.managerSessionId);
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/agents",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("lists active sessions in the caller's workspace and marks the caller", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);

    const spawn1 = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "audit auth.ts", label: "auditor" },
    });
    expect(spawn1.statusCode).toBe(200);
    const spawned = spawn1.json() as { session_id: string; agent_id: string; pid: number };

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/agents",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      agents: Array<{
        session_id: string;
        agent_id: string;
        role: { id: string; name: string };
        label?: string;
        pid: number;
        state: "busy" | "idle";
        started_at: number;
        is_caller: boolean;
      }>;
    };
    expect(body.agents).toHaveLength(2);

    const callerEntry = body.agents.find((a) => a.session_id === boot.managerSessionId);
    expect(callerEntry).toBeDefined();
    expect(callerEntry!.is_caller).toBe(true);
    expect(callerEntry!.role.name).toBe("manager");
    expect(callerEntry!.state).toBe("busy");

    const childEntry = body.agents.find((a) => a.session_id === spawned.session_id);
    expect(childEntry).toBeDefined();
    expect(childEntry!.is_caller).toBe(false);
    expect(childEntry!.agent_id).toBe(spawned.agent_id);
    expect(childEntry!.label).toBe("auditor");
    expect(childEntry!.pid).toBe(spawned.pid);
    expect(childEntry!.role.name).toBe("manager");
    expect(typeof childEntry!.started_at).toBe("number");

    await teardown(h);
  });

  it("excludes ended sessions", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);

    const spawn1 = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { role: "manager", prompt: "do x", label: "boot" },
    });
    const child = spawn1.json() as { session_id: string };
    await h.server.inject({
      method: "POST",
      url: `/sessions/${child.session_id}/end`,
    });

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/agents",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    const body = res.json() as { agents: Array<{ session_id: string }> };
    expect(body.agents.map((a) => a.session_id)).toEqual([boot.managerSessionId]);

    await teardown(h);
  });

  it("does not include sessions from other workspaces", async () => {
    const h = buildHarness();
    const bootA = await bootManager(h, repoPath);
    const bootB = await bootManager(h, otherRepoPath);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/agents",
      headers: { authorization: `Bearer ${bootA.managerToken}` },
    });
    const body = res.json() as { agents: Array<{ session_id: string }> };
    const ids = body.agents.map((a) => a.session_id);
    expect(ids).toContain(bootA.managerSessionId);
    expect(ids).not.toContain(bootB.managerSessionId);

    await teardown(h);
  });

  it("reports state=idle once the Stop hook clears busy", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);

    const stop = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: boot.managerSessionId,
        transcript_path: "/tmp/t.jsonl",
        cwd: repoPath,
        permission_mode: "default",
        hook_event_name: "Stop",
      },
    });
    expect(stop.statusCode).toBe(200);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/agents",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    const body = res.json() as { agents: Array<{ session_id: string; state: string }> };
    const callerEntry = body.agents.find((a) => a.session_id === boot.managerSessionId);
    expect(callerEntry!.state).toBe("idle");

    await teardown(h);
  });
});
