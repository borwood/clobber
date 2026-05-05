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
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import type { AgentSpawner } from "../src/types.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-persistent-agents-"));
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
  let pid = 9400;
  const spawner: AgentSpawner = (req) => {
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
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
    apiBase: "http://127.0.0.1:3300",
    cliEntry: "/abs/cli/index.ts",
    dispatches: createTriggerDispatchStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, agents, sessions };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface AgentCard {
  agent_id: string;
  label: string | null;
  role: { id: string; name: string };
  active_session: { id: string; started_at: number; busy: boolean } | null;
  last_started_at: number | null;
  office: {
    file_count: number;
    latest: {
      name: string;
      mtime_ms: number;
      preview: string;
    } | null;
  };
}

describe("GET /workspaces/:id/persistent-agents", () => {
  it("404s for an unknown workspace", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: "/workspaces/00000000-0000-0000-0000-000000000000/persistent-agents",
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns an empty list when the workspace has no persistent agents yet", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/persistent-agents`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: AgentCard[] };
    expect(body.agents).toEqual([]);

    await teardown(h);
  });

  it("only lists persistent agents — ephemeral agents are excluded", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const persistentRole = h.roles.create({ name: "manager", persistent: true });
    const ephemeralRole = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, persistentRole.id, 5);
    h.workspaceRoles.setCeiling(ws.id, ephemeralRole.id, 5);

    const persistentAgent = h.agents.create({
      workspace_id: ws.id,
      role_id: persistentRole.id,
      label: "primary",
    });
    h.agents.create({
      workspace_id: ws.id,
      role_id: ephemeralRole.id,
      label: "task-1",
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/persistent-agents`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: AgentCard[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.agent_id).toBe(persistentAgent.id);
    expect(body.agents[0]!.role.name).toBe("manager");
    expect(body.agents[0]!.label).toBe("primary");
    expect(body.agents[0]!.active_session).toBeNull();
    expect(body.agents[0]!.office.file_count).toBe(0);
    expect(body.agents[0]!.office.latest).toBeNull();

    await teardown(h);
  });

  it("surfaces an active session when the agent has one in flight", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "boot",
    });
    h.sessions.create({
      id: "session-active-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 7777,
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/persistent-agents`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: AgentCard[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.active_session).not.toBeNull();
    expect(body.agents[0]!.active_session!.id).toBe("session-active-1");
    expect(typeof body.agents[0]!.active_session!.started_at).toBe("number");
    // The session was created without going through the registry, so busy=false.
    expect(body.agents[0]!.active_session!.busy).toBe(false);

    await teardown(h);
  });

  it("returns a peek of the latest office note when files are present", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "boot",
    });
    const officeDir = join(repoPath, ".clobber", "offices", agent.id);
    mkdirSync(officeDir, { recursive: true });
    writeFileSync(join(officeDir, "notes-2026-05-04-120000.md"), "older note\n");
    writeFileSync(join(officeDir, "notes-2026-05-05-120000.md"), "newest content here\n");

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/persistent-agents`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: AgentCard[] };
    expect(body.agents[0]!.office.file_count).toBe(2);
    expect(body.agents[0]!.office.latest).not.toBeNull();
    expect(body.agents[0]!.office.latest!.name).toBe("notes-2026-05-05-120000.md");
    expect(body.agents[0]!.office.latest!.preview).toContain("newest content");

    await teardown(h);
  });
});
