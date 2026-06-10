import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { stubSpawnedAgent } from "./_spawner-stub.ts";
import type { HookPayload } from "@clobber/shared";

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly agents: ReturnType<typeof createAgentStore>;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly agentStatusLog: ReturnType<typeof createAgentStatusLogStore>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const agentStatusLog = createAgentStatusLogStore(db);
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog,
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent({ pid: 9999 }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, agents, sessions, agentStatusLog };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-stop-stall-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface SeededSession {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly sessionId: string;
}

function seedSession(
  h: Harness,
  opts: { persistent?: boolean } = {},
): SeededSession {
  const workspace = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({
    name: `role-${randomUUID()}`,
    persistent: opts.persistent === true,
  });
  const agent = h.agents.create({ workspace_id: workspace.id, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: workspace.id,
    role_id: role.id,
    pid: 9000,
  });
  return { workspaceId: workspace.id, agentId: agent.id, sessionId };
}

function taskCreateHook(
  sessionId: string,
  task: { id: string; subject: string },
): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    permission_mode: "bypassPermissions",
    hook_event_name: "PostToolUse",
    tool_name: "TaskCreate",
    tool_input: { subject: task.subject, description: `do ${task.subject}` },
    tool_use_id: `toolu_${randomUUID()}`,
    tool_response: { task: { id: task.id, subject: task.subject } },
  };
}

function stopHook(sessionId: string): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    permission_mode: "bypassPermissions",
    hook_event_name: "Stop",
  };
}

async function postHook(
  h: Harness,
  payload: HookPayload,
): Promise<unknown> {
  const res = await h.server.inject({ method: "POST", url: "/hook", payload });
  expect(res.statusCode).toBe(200);
  return res.json() as unknown;
}

describe("Stop-hook stall guard (#587)", () => {
  it("blocks an ephemeral worker Stop when phase plan has pending tasks and no final report", async () => {
    const h = buildHarness();
    const seeded = seedSession(h);

    // Seed a pending task via PostToolUse(TaskCreate)
    await postHook(h, taskCreateHook(seeded.sessionId, { id: "t1", subject: "research" }));

    const response = await postHook(h, stopHook(seeded.sessionId));
    expect(response).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("phase plan"),
    });

    await teardown(h);
  });

  it("allows the second Stop attempt (one-shot latch — no wrap-loop)", async () => {
    const h = buildHarness();
    const seeded = seedSession(h);

    await postHook(h, taskCreateHook(seeded.sessionId, { id: "t1", subject: "research" }));

    // First Stop is blocked
    const first = await postHook(h, stopHook(seeded.sessionId));
    expect((first as Record<string, unknown>)["decision"]).toBe("block");

    // Second Stop is allowed through
    const second = await postHook(h, stopHook(seeded.sessionId));
    expect(second).toEqual({ continue: true });

    await teardown(h);
  });

  it("does not block a persistent role (manager stops freely)", async () => {
    const h = buildHarness();
    const seeded = seedSession(h, { persistent: true });

    await postHook(h, taskCreateHook(seeded.sessionId, { id: "t1", subject: "research" }));

    const response = await postHook(h, stopHook(seeded.sessionId));
    expect(response).toEqual({ continue: true });

    await teardown(h);
  });

  it("does not block when no tasks are seeded (no phase plan)", async () => {
    const h = buildHarness();
    const seeded = seedSession(h);

    const response = await postHook(h, stopHook(seeded.sessionId));
    expect(response).toEqual({ continue: true });

    await teardown(h);
  });

  it("does not block when all tasks are completed", async () => {
    const h = buildHarness();
    const seeded = seedSession(h);

    await postHook(h, taskCreateHook(seeded.sessionId, { id: "t1", subject: "research" }));
    // Mark it completed
    await postHook(h, {
      session_id: seeded.sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      permission_mode: "bypassPermissions",
      hook_event_name: "PostToolUse",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "t1", status: "completed" },
      tool_use_id: `toolu_${randomUUID()}`,
      tool_response: { success: true, taskId: "t1", updatedFields: ["status"] },
    });

    const response = await postHook(h, stopHook(seeded.sessionId));
    expect(response).toEqual({ continue: true });

    await teardown(h);
  });

  it("does not block when a final report was posted this session", async () => {
    const h = buildHarness();
    const seeded = seedSession(h);

    await postHook(h, taskCreateHook(seeded.sessionId, { id: "t1", subject: "research" }));

    // Simulate a final report posted to the status log directly
    h.agentStatusLog.append({
      agent_id: seeded.agentId,
      session_id: seeded.sessionId,
      kind: "final-report",
      state: "done",
      summary: "Work complete",
    });

    const response = await postHook(h, stopHook(seeded.sessionId));
    expect(response).toEqual({ continue: true });

    await teardown(h);
  });
});
