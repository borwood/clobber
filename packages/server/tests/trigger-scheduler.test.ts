import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createTriggerScheduler } from "../src/trigger-scheduler.ts";
import { createTestClock, type TestClock } from "../src/clock.ts";
import { editRole } from "../src/edit-role.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "../src/spawn-pipeline.ts";
import { claudeRuntimeProvider, serializeUserMessage } from "@clobber/runtime";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import type { RoleVersion, Role } from "@clobber/shared";

interface Harness {
  db: ReturnType<typeof createDatabase>;
  clock: TestClock;
  workspaceId: string;
  managerRoleId: string;
  managerAgentId: string;
  workerRoleId: string;
  registry: ReturnType<typeof createAgentRegistry>;
  sessions: ReturnType<typeof createSessionStore>;
  agents: ReturnType<typeof createAgentStore>;
  roles: ReturnType<typeof createRoleStore>;
  roleVersions: ReturnType<typeof createRoleVersionStore>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  dispatches: ReturnType<typeof createTriggerDispatchStore>;
  scheduler: ReturnType<typeof createTriggerScheduler>;
  spawnCalls: Array<{ prompt: string; sessionId: string }>;
  liveStdins: Map<string, PassThrough>;
}

let repo: RepoFixture;
beforeEach(() => {
  repo = makeRepoFixture("clobber-trigger-scheduler-");
});
afterEach(() => {
  repo.cleanup();
});

function makeHarness(initial: Date): Harness {
  const db = createDatabase(":memory:");
  const clock = createTestClock(initial);
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
  const dispatches = createTriggerDispatchStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repo.path });
  seedWorkspaceRoles(db, ws.id);
  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const workerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", ws.id) as { id: string };

  const managerAgent = agents.create({
    workspace_id: ws.id,
    role_id: managerRow.id,
    label: "manager-1",
  });

  const liveStdins = new Map<string, PassThrough>();
  const spawnCalls: Array<{ prompt: string; sessionId: string }> = [];

  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    liveStdins.set(req.sessionId, stdin);
    spawnCalls.push({ prompt: req.prompt, sessionId: req.sessionId });
    return {
      sessionId: req.sessionId,
      pid: 7000 + spawnCalls.length,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };

  const spawnDeps: SpawnPipelineDeps = {
    workspaces,
    workspaceRoles,
    agents,
    sessions,
    sessionTokens,
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    registry,
    roles,
    roleVersions,
    runtimeProvider: claudeRuntimeProvider,
    agentQuestions,
    agentQuestionWaiter,
  };

  const scheduler = createTriggerScheduler({
    db,
    clock,
    workspaces,
    roles,
    roleVersions,
    agents,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    dispatches,
    attachSession: (input) => attachSessionToAgent(spawnDeps, input),
  });

  return {
    db,
    clock,
    workspaceId: ws.id,
    managerRoleId: managerRow.id,
    managerAgentId: managerAgent.id,
    workerRoleId: workerRow.id,
    registry,
    sessions,
    agents,
    roles,
    roleVersions,
    workspaces,
    dispatches,
    scheduler,
    spawnCalls,
    liveStdins,
  };
}

function getCurrentVersion(h: Harness, roleId: string): RoleVersion {
  const role = h.roles.get(roleId) as Role;
  return h.roleVersions.get(role.current_version_id!)!;
}

function setManagerCron(h: Harness, expr: string): void {
  const role = h.roles.get(h.managerRoleId) as Role;
  const cur = getCurrentVersion(h, h.managerRoleId);
  editRole(h.db, role, cur, { triggers: [{ kind: "cron", expr }] });
}

describe("TriggerScheduler — cron firing", () => {
  it("fires a cron trigger at the expected time and spawns a fresh session for an idle persistent agent", () => {
    // Start at 2026-05-05T08:59:00Z, cron at 9:00am UTC daily
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));
    setManagerCron(h, "0 9 * * *");
    h.scheduler.start();

    expect(h.spawnCalls.length).toBe(0);

    // Advance 30 seconds — not yet
    h.clock.advance(30_000);
    expect(h.spawnCalls.length).toBe(0);

    // Advance to 9:00:00 — should fire
    h.clock.advance(30_000);
    expect(h.spawnCalls.length).toBe(1);
    expect(h.spawnCalls[0]!.prompt).toContain("0 9 * * *");
    // The triggered-wake spawn goes through attachSessionToAgent, so it gets the
    // same office-context prefix as a manual /spawn for a persistent role.
    expect(h.spawnCalls[0]!.prompt).toContain("[Previously in this office]");
    expect(h.spawnCalls[0]!.prompt).toContain("[End of previously]");

    // The new session should be tied to the manager agent
    const active = h.sessions.listActiveForWorkspace(h.workspaceId);
    expect(active.length).toBe(1);
    expect(active[0]!.agent_id).toBe(h.managerAgentId);

    // Audit row written
    const audit = h.dispatches.listForAgent(h.managerAgentId);
    expect(audit.length).toBe(1);
    expect(audit[0]!.dispatch_outcome).toBe("spawned");
    expect(audit[0]!.trigger_kind).toBe("cron");

    h.scheduler.stop();
    h.db.close();
  });

  it("injects the synthetic prompt into a live persistent agent that is idle", () => {
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));
    setManagerCron(h, "0 9 * * *");

    // Start a live session for the manager agent (simulate already-running)
    const liveStdin = new PassThrough();
    const writes: Buffer[] = [];
    liveStdin.on("data", (c: Buffer) => writes.push(c));
    const sessionId = "session-live-manager-0001";
    h.sessions.create({
      id: sessionId,
      agent_id: h.managerAgentId,
      workspace_id: h.workspaceId,
      role_id: h.managerRoleId,
      pid: 4242,
    });
    h.registry.register(sessionId, liveStdin, () => {});
    h.registry.setBusy(sessionId, false);

    h.scheduler.start();
    h.clock.advance(60_000); // arrive at 9:00:00
    expect(h.spawnCalls.length).toBe(0);

    const text = Buffer.concat(writes).toString("utf8");
    expect(text).toContain("0 9 * * *");
    // Live-agent injection does NOT get the office-context prefix — the agent is
    // already in-flight and has its own context. Only fresh spawns get the prefix.
    expect(text).not.toContain("[Previously in this office]");
    expect(text).toBe(
      serializeUserMessage("a cron fired: 0 9 * * *"),
    );

    const audit = h.dispatches.listForAgent(h.managerAgentId);
    expect(audit.length).toBe(1);
    expect(audit[0]!.dispatch_outcome).toBe("injected");
    expect(audit[0]!.session_id).toBe(sessionId);

    h.scheduler.stop();
    h.db.close();
  });

  it("records skipped-busy when a live session is busy and does not inject", () => {
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));
    setManagerCron(h, "0 9 * * *");

    const liveStdin = new PassThrough();
    const writes: Buffer[] = [];
    liveStdin.on("data", (c: Buffer) => writes.push(c));
    const sessionId = "session-live-busy-0001";
    h.sessions.create({
      id: sessionId,
      agent_id: h.managerAgentId,
      workspace_id: h.workspaceId,
      role_id: h.managerRoleId,
      pid: 4243,
    });
    h.registry.register(sessionId, liveStdin, () => {});
    // registry registers busy=true by default — perfect.

    h.scheduler.start();
    h.clock.advance(60_000);
    expect(h.spawnCalls.length).toBe(0);
    expect(writes.length).toBe(0);

    const audit = h.dispatches.listForAgent(h.managerAgentId);
    expect(audit.length).toBe(1);
    expect(audit[0]!.dispatch_outcome).toBe("skipped-busy");

    h.scheduler.stop();
    h.db.close();
  });

  it("re-fires daily — schedules the next occurrence after firing", () => {
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));
    setManagerCron(h, "0 9 * * *");
    h.scheduler.start();

    h.clock.advance(60_000); // first fire at 09:00 — spawns a fresh session
    expect(h.spawnCalls.length).toBe(1);
    const firstSessionId = h.spawnCalls[0]!.sessionId;

    // Simulate the spawned session finishing its initial work
    h.registry.setBusy(firstSessionId, false);

    // Advance another 24h — cron should fire again into the live, idle session
    h.clock.advance(24 * 60 * 60 * 1000);

    const audit = h.dispatches.listForAgent(h.managerAgentId);
    expect(audit.length).toBe(2);
    expect(audit[0]!.dispatch_outcome).toBe("injected");
    expect(audit[0]!.session_id).toBe(firstSessionId);
    expect(audit[1]!.dispatch_outcome).toBe("spawned");

    h.scheduler.stop();
    h.db.close();
  });

  it("two agents with the same cron expression both fire independently", () => {
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));
    setManagerCron(h, "0 9 * * *");

    // Add a second persistent manager-style agent on the manager role
    const secondAgent = h.agents.create({
      workspace_id: h.workspaceId,
      role_id: h.managerRoleId,
      label: "manager-2",
    });

    h.scheduler.start();
    h.clock.advance(60_000);

    expect(h.spawnCalls.length).toBe(2);
    const audits = h.dispatches.listForWorkspace(h.workspaceId);
    expect(audits.length).toBe(2);
    const agentIds = audits.map((a) => a.agent_id).sort();
    expect(agentIds).toEqual(
      [h.managerAgentId, secondAgent.id].sort(),
    );

    h.scheduler.stop();
    h.db.close();
  });

  it("scheduler.reloadRole picks up trigger edits without restart", () => {
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));
    h.scheduler.start();

    // No triggers yet — advance past 9am, nothing fires
    h.clock.advance(60_000);
    expect(h.spawnCalls.length).toBe(0);

    // Now set a trigger for 10am and reload
    setManagerCron(h, "0 10 * * *");
    h.scheduler.reloadRole(h.managerRoleId);

    // Advance to 10:00 (currently 09:00, so +1h)
    h.clock.advance(60 * 60 * 1000);
    expect(h.spawnCalls.length).toBe(1);

    h.scheduler.stop();
    h.db.close();
  });

  it("does not fire triggers configured on ephemeral roles", () => {
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));

    // Force a worker version with a cron trigger directly via role-version-store
    // (Worker is ephemeral, so the API would 422; we go around it for the test.)
    const workerRole = h.roles.get(h.workerRoleId) as Role;
    const cur = h.roleVersions.get(workerRole.current_version_id!)!;
    const v2 = h.roleVersions.create({
      role_id: workerRole.id,
      version: 2,
      system_prompt: cur.system_prompt,
      skills_json: cur.skills_json,
      allowed_tools_json: cur.allowed_tools_json,
      allowed_cli_commands_json: cur.allowed_cli_commands_json,
      hooks_json: cur.hooks_json,
      triggers_json: JSON.stringify([{ kind: "cron", expr: "0 9 * * *" }]),
    });
    h.db
      .prepare("UPDATE roles SET current_version_id = ? WHERE id = ?")
      .run(v2.id, workerRole.id);

    // Spawn an ephemeral worker agent
    h.agents.create({
      workspace_id: h.workspaceId,
      role_id: h.workerRoleId,
      label: "worker-1",
    });

    h.scheduler.start();
    h.clock.advance(60_000);
    expect(h.spawnCalls.length).toBe(0);

    h.scheduler.stop();
    h.db.close();
  });

  it("ignores non-cron trigger kinds in v1 (file-watch, webhook, issue-assigned)", () => {
    const h = makeHarness(new Date("2026-05-05T08:59:00.000Z"));
    const role = h.roles.get(h.managerRoleId) as Role;
    const cur = getCurrentVersion(h, h.managerRoleId);
    editRole(h.db, role, cur, {
      triggers: [
        { kind: "webhook", path: "/hooks/x" },
        { kind: "file-watch", glob: "**/*.ts" },
      ],
    });

    h.scheduler.start();
    h.clock.advance(48 * 60 * 60 * 1000);
    expect(h.spawnCalls.length).toBe(0);

    h.scheduler.stop();
    h.db.close();
  });
});
