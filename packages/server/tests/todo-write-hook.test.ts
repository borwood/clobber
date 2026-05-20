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
  repoPath = mkdtempSync(join(tmpdir(), "clobber-todowrite-hook-"));
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

interface TodoItem {
  readonly content: string;
  readonly activeForm?: string;
  readonly status: "pending" | "in_progress" | "completed";
}

function todoWriteHook(sessionId: string, todos: TodoItem[]): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: { todos },
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
    tool_response: { success: true },
  };
}

describe("PostToolUse(TodoWrite) → agent_status_log (#87)", () => {
  it("first TodoWrite emits a todo-snapshot + one phase-transition per item (prev=absent)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const todos: TodoItem[] = [
      { content: "research", status: "in_progress" },
      { content: "failing-test", status: "pending" },
      { content: "implement", status: "pending" },
    ];

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: todoWriteHook(boot.sessionId, todos),
    });
    expect(res.statusCode).toBe(200);

    const snapshots = readLog(h, boot.agentId, "todo-snapshot");
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.session_id).toBe(boot.sessionId);
    expect(JSON.parse(snapshot.details_json!)).toEqual({ todos });

    const transitions = readLog(h, boot.agentId, "phase-transition");
    expect(transitions).toHaveLength(3);

    const research = transitions.find(
      (r) => (JSON.parse(r.details_json!) as { phase: string }).phase === "research",
    );
    expect(research).toBeDefined();
    expect(research!.state).toBe("in_progress");
    expect(JSON.parse(research!.details_json!)).toEqual({
      phase: "research",
      prev_status: "(absent)",
      new_status: "in_progress",
    });

    const test = transitions.find(
      (r) => (JSON.parse(r.details_json!) as { phase: string }).phase === "failing-test",
    );
    expect(test!.state).toBe("pending");
    expect((JSON.parse(test!.details_json!) as { prev_status: string }).prev_status).toBe("(absent)");

    await teardown(h);
  });

  it("second TodoWrite with status change emits one phase-transition", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const initial: TodoItem[] = [
      { content: "research", status: "in_progress" },
      { content: "implement", status: "pending" },
    ];
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: todoWriteHook(boot.sessionId, initial),
    });

    const updated: TodoItem[] = [
      { content: "research", status: "completed" },
      { content: "implement", status: "in_progress" },
    ];
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: todoWriteHook(boot.sessionId, updated),
    });

    const snapshots = readLog(h, boot.agentId, "todo-snapshot");
    expect(snapshots).toHaveLength(2);

    const transitions = readLog(h, boot.agentId, "phase-transition");
    // Initial: 2 transitions (both new). Update: 2 transitions (both changed status).
    expect(transitions).toHaveLength(4);

    const lastTwo = transitions.slice(-2);
    const research = lastTwo.find(
      (r) => (JSON.parse(r.details_json!) as { phase: string }).phase === "research",
    );
    expect(research!.state).toBe("completed");
    expect(JSON.parse(research!.details_json!)).toEqual({
      phase: "research",
      prev_status: "in_progress",
      new_status: "completed",
    });

    const implement = lastTwo.find(
      (r) => (JSON.parse(r.details_json!) as { phase: string }).phase === "implement",
    );
    expect(implement!.state).toBe("in_progress");
    expect(JSON.parse(implement!.details_json!)).toEqual({
      phase: "implement",
      prev_status: "pending",
      new_status: "in_progress",
    });

    await teardown(h);
  });

  it("identical TodoWrite emits nothing new", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const todos: TodoItem[] = [{ content: "research", status: "in_progress" }];

    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: todoWriteHook(boot.sessionId, todos),
    });
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: todoWriteHook(boot.sessionId, todos),
    });

    expect(readLog(h, boot.agentId, "todo-snapshot")).toHaveLength(1);
    expect(readLog(h, boot.agentId, "phase-transition")).toHaveLength(1);

    await teardown(h);
  });

  it("removed item emits a phase-transition to 'removed'", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const initial: TodoItem[] = [
      { content: "research", status: "completed" },
      { content: "scratch-task", status: "completed" },
    ];
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: todoWriteHook(boot.sessionId, initial),
    });

    const trimmed: TodoItem[] = [{ content: "research", status: "completed" }];
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: todoWriteHook(boot.sessionId, trimmed),
    });

    const transitions = readLog(h, boot.agentId, "phase-transition");
    const removal = transitions.find((r) => r.state === "removed");
    expect(removal).toBeDefined();
    expect(JSON.parse(removal!.details_json!)).toEqual({
      phase: "scratch-task",
      prev_status: "completed",
      new_status: "removed",
    });

    await teardown(h);
  });

  it("non-TodoWrite PostToolUse is ignored", async () => {
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
      tool_response: { stdout: "x", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    };

    await h.server.inject({ method: "POST", url: "/hook", payload: bashHook });

    expect(readLog(h, boot.agentId, "todo-snapshot")).toHaveLength(0);
    expect(readLog(h, boot.agentId, "phase-transition")).toHaveLength(0);

    await teardown(h);
  });

  it("malformed TodoWrite tool_input is silently ignored (does not 400 the hook)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const bad: HookPayload = {
      session_id: boot.sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "TodoWrite",
      tool_input: { not_todos: "garbage" },
      tool_use_id: "toolu_bad",
      tool_response: {},
    };

    const res = await h.server.inject({ method: "POST", url: "/hook", payload: bad });
    expect(res.statusCode).toBe(200);

    expect(readLog(h, boot.agentId, "todo-snapshot")).toHaveLength(0);
    expect(readLog(h, boot.agentId, "phase-transition")).toHaveLength(0);

    await teardown(h);
  });
});
