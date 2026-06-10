import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  claudeRuntimeProvider,
  codexRuntimeProvider,
  type RuntimeProvider,
} from "@clobber/runtime";
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
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import { attachSessionToAgent } from "../src/spawn-pipeline.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  repoPath: string;
}

function buildHarness(runtimeProvider: RuntimeProvider): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionTokens = createSessionTokenStore(db);

  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId!,
      pid: 9999,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };

  const repoPath = mkdtempSync(join(tmpdir(), "clobber-promptless-spawn-"));

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
    runtimeProvider,
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });

  return { server, db, workspaces, roles, workspaceRoles, sessions, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

describe("promptless spawn edge cases (#599)", () => {
  it("codex runtime + no prompt → 4xx (not 500)", async () => {
    const h = buildHarness(codexRuntimeProvider);
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    // Use a role with no defaultWakeProgram so no kick is synthesized.
    const role = h.roles.create({ name: "manager", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "promptless-codex" },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/prompt/i);

    await teardown(h);
  });

  // superviseCycle revival path: when both sessions die simultaneously after a
  // cycle, superviseCycle calls attachSessionToAgent with prompt: undefined to
  // revive the agent. With codex (requiresPrompt), this returns {ok: false} —
  // the fix ensures superviseCycle throws rather than silently discarding it.
  it("codex runtime + no prompt revival → attachSessionToAgent returns error, not throws", async () => {
    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const roleVersions = createRoleVersionStore(db);
    const workspaceRoles = createWorkspaceRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const sessionTokens = createSessionTokenStore(db);
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-revival-"));

    const spawner: AgentSpawner = (): SpawnedAgentInfo => {
      throw new Error("spawner should not be reached");
    };

    const deps = {
      workspaces,
      workspaceRoles,
      agents,
      sessions,
      sessionTokens,
      spawner,
      hookUrl: "http://test.invalid/hook",
      apiBase: DRIFT_STUB_API_BASE,
      cliEntry: "/dummy/cli.ts",
      registry: createAgentRegistry(),
      roles,
      roleVersions,
      runtimeProvider: codexRuntimeProvider,
      agentQuestions: createAgentQuestionStore(db),
      agentQuestionWaiter: createAgentQuestionWaiter(),
      onSessionEnded: () => {},
      notifications: createNotificationStore(db),
    };

    const ws = workspaces.create({ name: "ws", repo_path: repoPath });
    const role = roles.create({ name: "manager", persistent: false });
    workspaceRoles.setCeiling(ws.id, role.id, 5);
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id, label: "revival-target" });

    // This is exactly the call superviseCycle makes for the zero-session revival.
    const result = await attachSessionToAgent(deps, {
      workspace: ws,
      role,
      agent,
      prompt: undefined,
    });

    // Pre-fix: buildSpawnRequest would throw (unhandled → 500 or crash).
    // Post-fix: returns a clean error object the caller can act on.
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(422);
    expect((result as { error: string }).error).toMatch(/prompt/i);

    db.close();
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("claude runtime + no prompt → session registered idle, not busy", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    // Use a role with no defaultWakeProgram so no kick is synthesized.
    const role = h.roles.create({ name: "manager", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 5);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, label: "promptless-claude" },
    });
    expect(res.statusCode).toBe(200);
    const { session_id } = res.json() as { session_id: string };

    // Without the fix, busy is true and no Stop hook ever fires — stuck forever.
    // With the fix, no kick → busy starts false.
    const listing = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    });
    expect(listing.statusCode).toBe(200);
    const sessions = listing.json() as Array<{ session_id: string; busy: boolean }>;
    const session = sessions.find((s) => s.session_id === session_id);
    expect(session).toBeDefined();
    expect(session!.busy).toBe(false);

    await teardown(h);
  });
});
