import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import type { AgentSpawner, AgentSpawnRequest } from "../src/types.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-wake-persistent-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  calls: AgentSpawnRequest[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionTokens = createSessionTokenStore(db);
  const calls: AgentSpawnRequest[] = [];
  let pid = 9500;
  const spawner: AgentSpawner = (req) => {
    calls.push(req);
    pid += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId,
      pid,
      exited: new Promise<number | null>(() => {}),
      stdin,
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
    sessionTokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
    apiBase: "http://127.0.0.1:3300",
    cliEntry: "/abs/cli/index.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, agents, sessions, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

describe("POST /persistent-agents/:id/wake", () => {
  it("404s when the agent does not exist", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/persistent-agents/00000000-0000-0000-0000-000000000000/wake",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("409s when the agent already has an active session", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    seedWorkspaceRoles(h.db, ws.id);
    const role = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "boss",
    });
    h.sessions.create({
      id: "session-already-active",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1234,
    });

    const res = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agent.id}/wake`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/already/i);
    expect(h.calls).toHaveLength(0);
    await teardown(h);
  });

  it("400s when the agent's role is ephemeral (not wake-able)", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);
    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "task-1",
    });

    const res = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agent.id}/wake`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/persistent/i);
    expect(h.calls).toHaveLength(0);
    await teardown(h);
  });

  it("uses the workspace's wake_prompt for the prompt body", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: repoPath,
      wake_prompt: "custom workspace wake prompt — return to the floor",
    });
    seedWorkspaceRoles(h.db, ws.id);
    const role = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);
    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "boss",
    });

    const res = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agent.id}/wake`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.prompt).toContain("custom workspace wake prompt");

    await teardown(h);
  });

  it("creates a new session for an idle persistent agent and prepends office context", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    seedWorkspaceRoles(h.db, ws.id);
    const role = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "boss",
    });

    // Note left from a prior session
    const officeDir = join(repoPath, ".clobber", "offices", agent.id);
    mkdirSync(officeDir, { recursive: true });
    writeFileSync(join(officeDir, "notes-2026-05-04-090000.md"), "TODO: review PR #41\n");

    const res = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agent.id}/wake`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; agent_id: string; pid: number };
    expect(body.agent_id).toBe(agent.id);
    expect(typeof body.session_id).toBe("string");
    expect(typeof body.pid).toBe("number");

    expect(h.calls).toHaveLength(1);
    const prompt = h.calls[0]!.prompt;
    expect(prompt).toContain("[Previously in this office]");
    expect(prompt).toContain("notes-2026-05-04-090000.md");

    await teardown(h);
  });
});
