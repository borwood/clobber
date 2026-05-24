import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import type { HookPayload } from "@clobber/shared";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
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
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9999,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
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
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface BootedAgent {
  workspaceId: string;
  agentId: string;
  sessionId: string;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-task-hook-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function bootAgent(h: Harness): Promise<BootedAgent> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({ name: "worker", persistent: false });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string; agent_id: string };
  return {
    workspaceId: ws.id,
    agentId: body.agent_id,
    sessionId: body.session_id,
  };
}

interface LogRow {
  id: number;
  agent_id: string;
  session_id: string;
  event_id: number | null;
  kind: string;
  state: string;
  summary: string;
  details_json: string | null;
  created_at: number;
}

function readLog(h: Harness, agentId: string, kind?: string): LogRow[] {
  const sql = kind === undefined
    ? "SELECT * FROM agent_status_log WHERE agent_id = ? ORDER BY created_at ASC, id ASC"
    : "SELECT * FROM agent_status_log WHERE agent_id = ? AND kind = ? ORDER BY created_at ASC, id ASC";
  const params = kind === undefined ? [agentId] : [agentId, kind];
  return h.db.prepare(sql).all(...params) as LogRow[];
}

// Real TaskCreate PostToolUse payload shape (captured from the live event store):
// input { subject, description, activeForm? }; response { task: { id, subject } }.
// A freshly created task is always `pending` (status is not present in the payload).
function taskCreateHook(
  sessionId: string,
  task: { id: string; subject: string; activeForm?: string },
): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    permission_mode: "bypassPermissions",
    hook_event_name: "PostToolUse",
    tool_name: "TaskCreate",
    tool_input: {
      subject: task.subject,
      description: `do ${task.subject}`,
      ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
    },
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
    tool_response: { task: { id: task.id, subject: task.subject } },
  };
}

// Real TaskUpdate PostToolUse payload shape:
// input { taskId, status?, subject? }; response { success, taskId, updatedFields[], statusChange? }.
function taskUpdateHook(
  sessionId: string,
  update: {
    taskId: string;
    status?: "pending" | "in_progress" | "completed" | "deleted";
    subject?: string;
    from?: string;
  },
): HookPayload {
  const input: Record<string, unknown> = { taskId: update.taskId };
  if (update.status !== undefined) input.status = update.status;
  if (update.subject !== undefined) input.subject = update.subject;
  const response: Record<string, unknown> = {
    success: true,
    taskId: update.taskId,
    updatedFields: Object.keys(input).filter((k) => k !== "taskId"),
  };
  if (update.status !== undefined && update.from !== undefined) {
    response.statusChange = { from: update.from, to: update.status };
  }
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    permission_mode: "bypassPermissions",
    hook_event_name: "PostToolUse",
    tool_name: "TaskUpdate",
    tool_input: input,
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
    tool_response: response,
  };
}

async function hook(h: Harness, payload: HookPayload): Promise<number> {
  const res = await h.server.inject({ method: "POST", url: "/hook", payload });
  return res.statusCode;
}

describe("PostToolUse(Task*) → agent_status_log (#169)", () => {
  it("first TaskCreate emits a task-snapshot + one phase-transition (prev=absent)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    expect(
      await hook(h, taskCreateHook(boot.sessionId, { id: "1", subject: "research", activeForm: "researching" })),
    ).toBe(200);

    const snapshots = readLog(h, boot.agentId, "task-snapshot");
    expect(snapshots).toHaveLength(1);
    expect(JSON.parse(snapshots[0]!.details_json!)).toEqual({
      tasks: [{ id: "1", content: "research", status: "pending", activeForm: "researching" }],
    });

    const transitions = readLog(h, boot.agentId, "phase-transition");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.state).toBe("pending");
    expect(JSON.parse(transitions[0]!.details_json!)).toEqual({
      phase: "research",
      prev_status: "(absent)",
      new_status: "pending",
    });

    await teardown(h);
  });

  it("TaskUpdate flips an existing task's status and emits one phase-transition", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    await hook(h, taskCreateHook(boot.sessionId, { id: "1", subject: "research", activeForm: "researching" }));
    await hook(h, taskCreateHook(boot.sessionId, { id: "2", subject: "implement", activeForm: "implementing" }));
    await hook(h, taskUpdateHook(boot.sessionId, { taskId: "1", status: "in_progress", from: "pending" }));

    // 2 creates (absent→pending) + 1 update (pending→in_progress) = 3 transitions.
    const transitions = readLog(h, boot.agentId, "phase-transition");
    expect(transitions).toHaveLength(3);

    const last = transitions[transitions.length - 1]!;
    expect(last.state).toBe("in_progress");
    expect(JSON.parse(last.details_json!)).toEqual({
      phase: "research",
      prev_status: "pending",
      new_status: "in_progress",
    });

    // Latest snapshot reflects the reconstructed full list with task 1 advanced.
    const snapshots = readLog(h, boot.agentId, "task-snapshot");
    const latest = JSON.parse(snapshots[snapshots.length - 1]!.details_json!) as {
      tasks: { id: string; content: string; status: string; activeForm?: string }[];
    };
    expect(latest.tasks).toEqual([
      { id: "1", content: "research", status: "in_progress", activeForm: "researching" },
      { id: "2", content: "implement", status: "pending", activeForm: "implementing" },
    ]);

    await teardown(h);
  });

  it("TaskUpdate to in_progress then completed emits both transitions in order", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    await hook(h, taskCreateHook(boot.sessionId, { id: "1", subject: "research" }));
    await hook(h, taskUpdateHook(boot.sessionId, { taskId: "1", status: "in_progress", from: "pending" }));
    await hook(h, taskUpdateHook(boot.sessionId, { taskId: "1", status: "completed", from: "in_progress" }));

    const transitions = readLog(h, boot.agentId, "phase-transition");
    const states = transitions.map((t) => t.state);
    expect(states).toEqual(["pending", "in_progress", "completed"]);

    await teardown(h);
  });

  it("TaskUpdate status=deleted emits a 'removed' transition and drops the task from the snapshot", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    await hook(h, taskCreateHook(boot.sessionId, { id: "1", subject: "research" }));
    await hook(h, taskCreateHook(boot.sessionId, { id: "2", subject: "scratch" }));
    await hook(h, taskUpdateHook(boot.sessionId, { taskId: "2", status: "deleted", from: "pending" }));

    const transitions = readLog(h, boot.agentId, "phase-transition");
    const removal = transitions.find((t) => t.state === "removed");
    expect(removal).toBeDefined();
    expect(JSON.parse(removal!.details_json!)).toEqual({
      phase: "scratch",
      prev_status: "pending",
      new_status: "removed",
    });

    const snapshots = readLog(h, boot.agentId, "task-snapshot");
    const latest = JSON.parse(snapshots[snapshots.length - 1]!.details_json!) as {
      tasks: { id: string }[];
    };
    expect(latest.tasks.map((t) => t.id)).toEqual(["1"]);

    await teardown(h);
  });

  it("non-Task* PostToolUse is ignored", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const bashHook: HookPayload = {
      session_id: boot.sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_bash",
      tool_response: { stdout: "x", stderr: "", interrupted: false },
    };
    await hook(h, bashHook);

    expect(readLog(h, boot.agentId, "task-snapshot")).toHaveLength(0);
    expect(readLog(h, boot.agentId, "phase-transition")).toHaveLength(0);

    await teardown(h);
  });

  it("malformed Task* tool_input is silently ignored (does not 400 the hook)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const bad: HookPayload = {
      session_id: boot.sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "TaskCreate",
      tool_input: { not_a_subject: "garbage" },
      tool_use_id: "toolu_bad",
      tool_response: {},
    };
    expect(await hook(h, bad)).toBe(200);

    expect(readLog(h, boot.agentId, "task-snapshot")).toHaveLength(0);
    expect(readLog(h, boot.agentId, "phase-transition")).toHaveLength(0);

    await teardown(h);
  });
});
