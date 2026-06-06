import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { createServer } from "../src/server.ts";
import {
  attachSessionToAgent,
  type SpawnPipelineDeps,
} from "../src/spawn-pipeline.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
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
import type { AgentSpawner, AgentSpawnRequest } from "../src/types.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-spawn-office-ctx-"));
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
  const spawner: AgentSpawner = (req) => {
    calls.push(req);
    const stdin = new PassThrough();
    stdin.resume();
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9200,
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
    apiBase: DRIFT_STUB_API_BASE,
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

describe("spawn — office continuity at spawn (#55)", () => {
  it("persistent spawn into an empty office prepends the empty 'Previously' block", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "boot" },
    });
    expect(res.statusCode).toBe(200);

    expect(h.calls).toHaveLength(1);
    const system = h.calls[0]!.appendSystemPrompt!;
    expect(system).toContain("[Previously in this office]");
    expect(system).toContain("office is empty");
    expect(system).toContain("[End of previously]");
    // The user-provided prompt rides the opening user turn alone.
    expect(h.calls[0]!.prompt).toBe("do work");

    await teardown(h);
  });

  it("a fresh persistent spawn always sees an empty office (each spawn = new agent)", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 2);

    const a = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "first", label: "boot" },
    });
    expect(a.statusCode).toBe(200);

    const b = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "second", label: "next" },
    });
    expect(b.statusCode).toBe(200);

    expect(h.calls).toHaveLength(2);
    // Both new agents → both their offices are empty
    expect(h.calls[0]!.appendSystemPrompt).toContain("office is empty");
    expect(h.calls[1]!.appendSystemPrompt).toContain("office is empty");

    await teardown(h);
  });

  it("ephemeral spawn does not prepend any office context", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "task body", label: "task" },
    });
    expect(res.statusCode).toBe(200);

    expect(h.calls).toHaveLength(1);
    const prompt = h.calls[0]!.prompt;
    // The worker's `task` default supplies the opening kick (#213); either way
    // no office continuity rides an ephemeral spawn.
    expect(prompt).toContain("run your desk protocol");
    expect(prompt).not.toContain("[Previously in this office]");

    await teardown(h);
  });

  it("re-attaching the same persistent agent surfaces notes written in the prior session", async () => {
    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const roleVersions = createRoleVersionStore(db);
    const workspaceRoles = createWorkspaceRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const sessionTokens = createSessionTokenStore(db);
    const agentQuestions = createAgentQuestionStore(db);
    const agentQuestionWaiter = createAgentQuestionWaiter();
    const registry = createAgentRegistry();

    const calls: AgentSpawnRequest[] = [];
    const spawner: AgentSpawner = (req) => {
      calls.push(req);
      const stdin = new PassThrough();
      stdin.resume();
      if (req.sessionId === undefined) throw new Error("expected sessionId");
      return {
        sessionId: req.sessionId,
        pid: 9300 + calls.length,
        exited: new Promise<number | null>(() => {}),
        stdin,
        kill: () => {},
      };
    };

    const ws = workspaces.create({ name: "ws", repo_path: repoPath });
    seedWorkspaceRoles(db, ws.id);
    const managerRow = db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    workspaceRoles.setCeiling(ws.id, managerRow.id, 5);
    const role = roles.get(managerRow.id)!;

    const agent = agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "single-agent-multi-session",
    });

    const spawnDeps: SpawnPipelineDeps = {
      workspaces,
      workspaceRoles,
      agents,
      sessions,
      sessionTokens,
      spawner,
      hookUrl: "http://test.invalid/hook",
      apiBase: DRIFT_STUB_API_BASE,
      cliEntry: "/dummy/cli.ts",
      registry,
      roles,
      roleVersions,
      runtimeProvider: claudeRuntimeProvider,
      agentQuestions,
      agentQuestionWaiter,
      onSessionEnded: () => {},
    };

    const workspace = workspaces.get(ws.id)!;

    // First attach — empty office on wake
    const r1 = await attachSessionToAgent(spawnDeps, {
      workspace,
      role,
      agent,
      prompt: "first wake",
    });
    expect(r1.ok).toBe(true);
    expect(calls[0]!.appendSystemPrompt).toContain("office is empty");

    // Agent leaves a note before ending the session
    const officeDir = join(repoPath, ".clobber", "offices", agent.id);
    writeFileSync(
      join(officeDir, "notes-2026-05-04-120000.md"),
      "remember: PR #41 still needs review\n",
    );

    // Second attach to the SAME agent — note should appear in the prefix
    const r2 = await attachSessionToAgent(spawnDeps, {
      workspace,
      role,
      agent,
      prompt: "second wake",
    });
    expect(r2.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.appendSystemPrompt).toContain("notes-2026-05-04-120000.md");
    expect(calls[1]!.appendSystemPrompt).not.toContain("office is empty");
    expect(calls[1]!.prompt).toBe("second wake");

    db.close();
  });

  it("persistent spawn materialises the office-notes skill even if the role's stored skills omit it", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "boot" },
    });
    expect(res.statusCode).toBe(200);

    const skillPath = join(
      repoPath,
      ".clobber",
      "roles",
      "manager",
      "skills",
      "office-notes",
      "SKILL.md",
    );
    expect(existsSync(skillPath)).toBe(true);
    const skillBody = readFileSync(skillPath, "utf8");
    expect(skillBody).toContain("CLOBBER_OFFICE_DIR");
    expect(skillBody).toContain("# office-notes");

    await teardown(h);
  });
});
