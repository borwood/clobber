import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
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
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createTriggerScheduler } from "../src/trigger-scheduler.ts";
import { createTestClock } from "../src/clock.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "../src/spawn-pipeline.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #685 bootstrap-interview AC1 — the shipped `manager` role declares a
// workspace-open trigger guarded on `.clobber/bootstrap.json` (first-open
// detection reuses the existing trigger + a filesystem guard, not a new
// trigger kind). This exercises the REAL shipped manager bundle end to end —
// not a synthetic trigger — so a regression in the manifest declaration or
// the guard evaluator shows up here.

interface Harness {
  db: ReturnType<typeof createDatabase>;
  workspaceId: string;
  managerAgentId: string;
  scheduler: ReturnType<typeof createTriggerScheduler>;
  dispatches: ReturnType<typeof createTriggerDispatchStore>;
  spawnCalls: Array<{ prompt: string; sessionId: string }>;
}

function buildHarness(repoPath: string): Harness {
  const db = createDatabase(":memory:");
  const clock = createTestClock(new Date("2026-08-26T09:00:00.000Z"));
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
  const agentStatusLog = createAgentStatusLogStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  // No `forks` arg — the no-repo test path, which snapshots the REAL shipped
  // manager bundle (manifest.triggers included) straight into role_versions.
  seedWorkspaceRoles(db, ws.id);
  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const managerAgent = agents.create({
    workspace_id: ws.id,
    role_id: managerRow.id,
    label: "manager-1",
  });

  const spawnCalls: Harness["spawnCalls"] = [];
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    spawnCalls.push({ prompt: req.prompt!, sessionId: req.sessionId });
    return {
      sessionId: req.sessionId,
      pid: 8000 + spawnCalls.length,
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
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    registry,
    roles,
    roleVersions,
    runtimeProvider: claudeRuntimeProvider,
    agentQuestions,
    agentQuestionWaiter,
    onSessionEnded: () => {},
    notifications: createNotificationStore(db),
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
    agentStatusLog,
    attachSession: (input) => attachSessionToAgent(spawnDeps, input),
    resumeEndedSession: async () => ({
      ok: false,
      status: 409,
      error: "runtime does not support resume" as const,
    }),
  });

  return {
    db,
    workspaceId: ws.id,
    managerAgentId: managerAgent.id,
    scheduler,
    dispatches,
    spawnCalls,
  };
}

function writeSentinel(repoPath: string): void {
  const dir = join(repoPath, ".clobber");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bootstrap.json"), JSON.stringify({ done: true }));
}

describe("TriggerScheduler — manager workspace-open guard (#685)", () => {
  let repo: RepoFixture;

  it("fires the bootstrap-interview wake when no sentinel exists (first open)", async () => {
    repo = makeRepoFixture("clobber-bootstrap-guard-");
    const h = buildHarness(repo.path);
    h.scheduler.start();

    const result = await h.scheduler.fireWorkspaceOpen(h.workspaceId, undefined);
    expect(result.dispatched).toBe(1);
    expect(h.spawnCalls.length).toBe(1);

    const audit = h.dispatches.listForAgent(h.managerAgentId);
    expect(audit.length).toBe(1);
    expect(audit[0]!.dispatch_outcome).toBe("spawned");

    h.scheduler.stop();
    h.db.close();
    repo.cleanup();
  });

  it("does not fire when .clobber/bootstrap.json already exists (sentinel present)", async () => {
    repo = makeRepoFixture("clobber-bootstrap-guard-");
    writeSentinel(repo.path);
    const h = buildHarness(repo.path);
    h.scheduler.start();

    const result = await h.scheduler.fireWorkspaceOpen(h.workspaceId, undefined);
    expect(result.dispatched).toBe(0);
    expect(h.spawnCalls.length).toBe(0);

    // A guard block is a silent skip (mirrors the debounce skip) — no audit
    // row, no dispatch outcome recorded, same as "nothing happened".
    expect(h.dispatches.listForAgent(h.managerAgentId).length).toBe(0);

    h.scheduler.stop();
    h.db.close();
    repo.cleanup();
  });

  it("fires again once the sentinel is deleted (OQ-3 manual re-offer path)", async () => {
    repo = makeRepoFixture("clobber-bootstrap-guard-");
    writeSentinel(repo.path);
    const h = buildHarness(repo.path);
    h.scheduler.start();

    expect((await h.scheduler.fireWorkspaceOpen(h.workspaceId, undefined)).dispatched).toBe(0);

    rmSync(join(repo.path, ".clobber", "bootstrap.json"));
    expect((await h.scheduler.fireWorkspaceOpen(h.workspaceId, undefined)).dispatched).toBe(1);
    expect(h.spawnCalls.length).toBe(1);

    h.scheduler.stop();
    h.db.close();
    repo.cleanup();
  });
});
