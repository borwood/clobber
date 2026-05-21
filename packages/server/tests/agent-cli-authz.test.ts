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
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { SpawnedAgentInfo } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

interface RoleSession {
  readonly sessionId: string;
  readonly token: string;
}

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaceId: string;
  readonly manager: RoleSession;
  readonly worker: RoleSession;
  readonly repoPath: string;
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
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-cli-authz-"));
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });

  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager");
  if (managerRole === null) throw new Error("manager role not seeded");
  const workerRole = roles.findInWorkspace(ws.id, "worker");
  if (workerRole === null) throw new Error("worker role not seeded");

  function provisionSession(roleId: string): RoleSession {
    const agent = agents.create({ workspace_id: ws.id, role_id: roleId });
    const sessionId = randomUUID();
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleId,
      pid: 1,
    });
    const token = tokens.mint(sessionId);
    return { sessionId, token };
  }

  const manager = provisionSession(managerRole.id);
  const worker = provisionSession(workerRole.id);

  const stub: SpawnedAgentInfo = {
    sessionId: "stub",
    pid: 9000,
    exited: new Promise<number | null>(() => {}),
    stdin: makeStdin(),
    kill: () => {},
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
    spawner: () => ({ ...stub, sessionId: randomUUID() }),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });

  return { server, db, workspaceId: ws.id, manager, worker, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("agent CLI authz — manager wildcard vs worker allow-list", () => {
  it("manager (allowedCliCommands: ['*']) can hit every /agent/* endpoint", async () => {
    const h = buildHarness();
    try {
      const meRes = await h.server.inject({
        method: "GET",
        url: "/agent/me",
        headers: bearer(h.manager.token),
      });
      expect(meRes.statusCode).toBe(200);

      const spawnRes = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: bearer(h.manager.token),
        payload: { role: "worker", prompt: "go", label: "from-mgr" },
      });
      expect(spawnRes.statusCode).toBe(200);

      const rolesRes = await h.server.inject({
        method: "GET",
        url: "/agent/roles",
        headers: bearer(h.manager.token),
      });
      expect(rolesRes.statusCode).toBe(200);
    } finally {
      await teardown(h);
    }
  });

  it("worker can call its allowed verbs (whoami, status, ask, report) but is denied dangerous ones (spawn, kill, agents, transcript, roles.*)", async () => {
    const h = buildHarness();
    try {
      const allowedMe = await h.server.inject({
        method: "GET",
        url: "/agent/me",
        headers: bearer(h.worker.token),
      });
      expect(allowedMe.statusCode).toBe(200);

      const allowedStatus = await h.server.inject({
        method: "POST",
        url: "/agent/status",
        headers: bearer(h.worker.token),
        payload: { state: "working", summary: "running tests" },
      });
      expect(allowedStatus.statusCode).toBe(200);

      const deniedSpawn = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: bearer(h.worker.token),
        payload: { role: "worker", prompt: "go", label: "naughty" },
      });
      expect(deniedSpawn.statusCode).toBe(403);
      const spawnBody = deniedSpawn.json() as { error: string };
      expect(spawnBody.error).toMatch(/spawn/);
      expect(spawnBody.error).toMatch(/worker/);

      const deniedAgents = await h.server.inject({
        method: "GET",
        url: "/agent/agents",
        headers: bearer(h.worker.token),
      });
      expect(deniedAgents.statusCode).toBe(403);

      const deniedRolesList = await h.server.inject({
        method: "GET",
        url: "/agent/roles",
        headers: bearer(h.worker.token),
      });
      expect(deniedRolesList.statusCode).toBe(403);

      const deniedRolesFork = await h.server.inject({
        method: "POST",
        url: "/agent/roles/manager/fork",
        headers: bearer(h.worker.token),
        payload: { new_name: "evil-twin" },
      });
      expect(deniedRolesFork.statusCode).toBe(403);
    } finally {
      await teardown(h);
    }
  });

  it("403 carries role + command name so the agent learns from the error", async () => {
    const h = buildHarness();
    try {
      const denied = await h.server.inject({
        method: "POST",
        url: "/agent/sessions/00000000-0000-4000-8000-000000000000/kill",
        headers: bearer(h.worker.token),
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/'kill'/);
      expect(body.error).toMatch(/'worker'/);
    } finally {
      await teardown(h);
    }
  });

  it("authz layer runs after auth — invalid token still 401, not 403", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: { authorization: "Bearer not-a-real-token" },
        payload: { role: "worker", prompt: "go", label: "x" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await teardown(h);
    }
  });

  it("hook receivers do NOT pass through the agent CLI authz layer", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "POST",
        url: "/hook",
        payload: {
          hook_event_name: "SessionStart",
          session_id: h.worker.sessionId,
          source: "startup",
        },
      });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    } finally {
      await teardown(h);
    }
  });

  it("forked role inherits the source's allowed_cli_commands_json", async () => {
    const h = buildHarness();
    try {
      const fork = await h.server.inject({
        method: "POST",
        url: "/agent/roles/worker/fork",
        headers: bearer(h.manager.token),
        payload: { new_name: "worker-fork" },
      });
      expect(fork.statusCode).toBe(201);
      const { role_id, version_id } = fork.json() as {
        role_id: string;
        version_id: string;
      };
      const row = h.db
        .prepare(
          "SELECT allowed_cli_commands_json FROM role_versions WHERE id = ?",
        )
        .get(version_id) as { allowed_cli_commands_json: string };
      const allowed = JSON.parse(row.allowed_cli_commands_json);
      expect(allowed).toEqual(["whoami", "ask", "status", "report"]);
      expect(role_id).toBeDefined();
    } finally {
      await teardown(h);
    }
  });
});
