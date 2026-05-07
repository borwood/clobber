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
import type { AgentSpawner } from "../src/types.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-whiteboard-"));
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
    agentStatusLog: createAgentStatusLogStore(db),
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

interface SessionView {
  id: string;
  started_at: number;
  busy: boolean;
  latest_status: { state: string; summary: string; updated_at: number } | null;
}

interface OfficeCard {
  agent_id: string;
  label: string | null;
  role: { id: string; name: string };
  active_session: SessionView | null;
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

interface DeskCard {
  agent_id: string;
  label: string | null;
  role: { id: string; name: string };
  session: SessionView;
}

interface WhiteboardBody {
  offices: OfficeCard[];
  desks: DeskCard[];
}

describe("GET /workspaces/:id/whiteboard", () => {
  it("404s for an unknown workspace", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: "/workspaces/00000000-0000-0000-0000-000000000000/whiteboard",
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns empty offices and desks when the workspace has no agents", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.offices).toEqual([]);
    expect(body.desks).toEqual([]);

    await teardown(h);
  });

  it("places persistent agents in offices and excludes ephemerals from offices", async () => {
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
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.offices).toHaveLength(1);
    expect(body.offices[0]!.agent_id).toBe(persistentAgent.id);
    expect(body.offices[0]!.role.name).toBe("manager");
    expect(body.offices[0]!.label).toBe("primary");
    expect(body.offices[0]!.active_session).toBeNull();
    expect(body.offices[0]!.office.file_count).toBe(0);

    expect(body.desks).toEqual([]);

    await teardown(h);
  });

  it("surfaces an active session on the persistent agent's office card", async () => {
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
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.offices).toHaveLength(1);
    expect(body.offices[0]!.active_session).not.toBeNull();
    expect(body.offices[0]!.active_session!.id).toBe("session-active-1");
    expect(typeof body.offices[0]!.active_session!.started_at).toBe("number");
    expect(body.offices[0]!.active_session!.busy).toBe(false);

    await teardown(h);
  });

  it("includes latest_status on the office's active session", async () => {
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
      id: "session-with-status",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 7777,
    });
    const statuses = createAgentStatusStore(h.db);
    statuses.upsert({
      session_id: "session-with-status",
      state: "blocked",
      summary: "waiting on schema decision for triggers",
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    const card = body.offices[0]!;
    expect(card.active_session!.latest_status).not.toBeNull();
    expect(card.active_session!.latest_status!.state).toBe("blocked");
    expect(card.active_session!.latest_status!.summary).toBe(
      "waiting on schema decision for triggers",
    );

    await teardown(h);
  });

  it("returns latest_status: null when an office's active session has no self-report yet", async () => {
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
      id: "session-no-status",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 7777,
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.offices[0]!.active_session!.latest_status).toBeNull();

    await teardown(h);
  });

  it("peeks the latest office note when files are present", async () => {
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
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.offices[0]!.office.file_count).toBe(2);
    expect(body.offices[0]!.office.latest).not.toBeNull();
    expect(body.offices[0]!.office.latest!.name).toBe("notes-2026-05-05-120000.md");
    expect(body.offices[0]!.office.latest!.preview).toContain("newest content");

    await teardown(h);
  });

  it("places ephemeral agents on desks while their session is active", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "task-A",
    });
    h.sessions.create({
      id: "ephemeral-session-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 8888,
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.offices).toEqual([]);
    expect(body.desks).toHaveLength(1);
    expect(body.desks[0]!.agent_id).toBe(agent.id);
    expect(body.desks[0]!.role.name).toBe("worker");
    expect(body.desks[0]!.label).toBe("task-A");
    expect(body.desks[0]!.session.id).toBe("ephemeral-session-1");
    expect(body.desks[0]!.session.busy).toBe(false);
    expect(body.desks[0]!.session.latest_status).toBeNull();

    await teardown(h);
  });

  it("surfaces the ephemeral session's latest_status on the desk", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "task-B",
    });
    h.sessions.create({
      id: "ephemeral-session-2",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 8889,
    });
    const statuses = createAgentStatusStore(h.db);
    statuses.upsert({
      session_id: "ephemeral-session-2",
      state: "working",
      summary: "running migration on staging",
    });

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.desks[0]!.session.latest_status).not.toBeNull();
    expect(body.desks[0]!.session.latest_status!.state).toBe("working");
    expect(body.desks[0]!.session.latest_status!.summary).toBe(
      "running migration on staging",
    );

    await teardown(h);
  });

  it("hides ephemeral agents from the whiteboard when their session has ended", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "task-C",
    });
    h.sessions.create({
      id: "ephemeral-session-3",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 8890,
    });
    h.sessions.markEnded("ephemeral-session-3");

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/whiteboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhiteboardBody;
    expect(body.offices).toEqual([]);
    expect(body.desks).toEqual([]);

    await teardown(h);
  });
});
