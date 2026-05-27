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
import { editRole } from "../src/edit-role.ts";
import type { WakeProgram } from "@clobber/shared";
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

  it("a no-task wake produces no fabricated user turn — durable framing rides the system prompt", async () => {
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

    const officeDir = join(repoPath, ".clobber", "offices", agent.id);
    mkdirSync(officeDir, { recursive: true });
    writeFileSync(join(officeDir, "notes-2026-05-04-090000.md"), "TODO: review PR #41\n");

    const res = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agent.id}/wake`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls).toHaveLength(1);
    // No synthetic "orient yourself" turn.
    expect(h.calls[0]!.prompt).toBeUndefined();
    // Office continuity is composed into the system prompt instead.
    expect(h.calls[0]!.appendSystemPrompt).toContain("[Previously in this office]");
    expect(h.calls[0]!.appendSystemPrompt).toContain("notes-2026-05-04-090000.md");

    await teardown(h);
  });

  it("creates a new session for an idle persistent agent and composes office context", async () => {
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
    const system = h.calls[0]!.appendSystemPrompt;
    expect(system).toContain("[Previously in this office]");
    expect(system).toContain("notes-2026-05-04-090000.md");

    await teardown(h);
  });

  it("wakes the manager with a chosen wake-program — composes its layer-C addon and kick (#213)", async () => {
    // Surface 3 — the office affordance: a human picks a non-default program to
    // wake the persistent agent with.
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    seedWorkspaceRoles(h.db, ws.id);
    const roleRow = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    h.workspaceRoles.setCeiling(ws.id, roleRow.id, 5);
    setManagerWakePrograms(h, roleRow.id, [
      { name: "triage", system: "LAYER-C-TRIAGE", user: "Triage the queue." },
    ]);

    const agent = h.agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "boss" });

    const res = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agent.id}/wake`,
      payload: { wake_program: "triage" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.appendSystemPrompt).toContain("LAYER-C-TRIAGE");
    expect(h.calls[0]!.prompt).toBe("Triage the queue.");
    await teardown(h);
  });

  it("defaults the office wake to idle — no layer-C addon and no kick (#213)", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    seedWorkspaceRoles(h.db, ws.id);
    const roleRow = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    h.workspaceRoles.setCeiling(ws.id, roleRow.id, 5);
    setManagerWakePrograms(h, roleRow.id, [
      { name: "triage", system: "LAYER-C-TRIAGE", user: "Triage the queue." },
    ]);

    const agent = h.agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "boss" });

    const res = await h.server.inject({
      method: "POST",
      url: `/persistent-agents/${agent.id}/wake`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls).toHaveLength(1);
    // Even though the manager declares a `triage` program, the office wake
    // defaults to idle — never auto-selecting a role program.
    expect(h.calls[0]!.appendSystemPrompt).not.toContain("LAYER-C-TRIAGE");
    expect(h.calls[0]!.prompt).toBeUndefined();
    await teardown(h);
  });
});

function setManagerWakePrograms(
  h: Harness,
  roleId: string,
  programs: readonly WakeProgram[],
): void {
  const versions = createRoleVersionStore(h.db);
  const role = h.roles.get(roleId)!;
  const current = versions.get(role.current_version_id!)!;
  editRole(h.db, role, current, { wakePrograms: programs });
}
