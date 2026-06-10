import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HabitSchema, type Habit, type HookPayload, type TranscriptLine, type CreateNotification } from "@clobber/shared";
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
import { createNotificationStore } from "../src/notification-store.ts";

function habit(partial: Record<string, unknown>): Habit {
  return HabitSchema.parse(partial);
}

// Writes JSONL transcript lines to a temp file and returns its path.
function writeTranscript(lines: object[]): string {
  const path = join(tmpdir(), `transcript-${randomUUID()}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

// One assistant turn with the given input_tokens count.
function assistantLine(inputTokens: number): object {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: 50 },
    },
  };
}

let repoPath: string;
let habits: readonly Habit[] = [];
let readTranscriptTailCalls = 0;
let customTailReader: ((path: string) => Promise<TranscriptLine[]>) | undefined;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-session-length-"));
  habits = [];
  readTranscriptTailCalls = 0;
  customTailReader = undefined;
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly sessionId: string;
  readonly agentId: string;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const countingReader = async (path: string): Promise<TranscriptLine[]> => {
    readTranscriptTailCalls++;
    if (customTailReader !== undefined) return customTailReader(path);
    // Default: parse the whole file (fine for small test fixtures).
    const text = await Bun.file(path).text();
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .flatMap((l) => {
        try { return [JSON.parse(l) as TranscriptLine]; } catch { return []; }
      });
  };
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
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent({ pid: 9999 }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    resolveSessionHabits: () => habits,
    habitRandom: () => 0,
    habitRunBash: () => "",
    habitReadTranscriptTail: countingReader,
  });
  const workspace = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: `role-${randomUUID()}`, persistent: false });
  const agent = agents.create({ workspace_id: workspace.id, role_id: role.id });
  const sessionId = randomUUID();
  sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: workspace.id,
    role_id: role.id,
    pid: 9000,
  });
  return { server, db, sessionId, agentId: agent.id };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

async function post(h: Harness, payload: HookPayload): Promise<unknown> {
  const res = await h.server.inject({ method: "POST", url: "/hook", payload });
  expect(res.statusCode).toBe(200);
  return res.json();
}

function postToolUse(sessionId: string, transcriptPath: string): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: repoPath,
    permission_mode: "bypassPermissions",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    tool_use_id: "toolu_test",
    tool_response: { output: "hi" },
  };
}

function userPromptSubmit(sessionId: string, transcriptPath: string): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: repoPath,
    permission_mode: "bypassPermissions",
    hook_event_name: "UserPromptSubmit",
    prompt: "continue please",
  };
}

describe("self.session-length habit (#184)", () => {
  // AC2 — non-inert, real path: real transcript file, real /hook POST.
  // Usage >= threshold on PostToolUse → additionalContext carries the hint.
  it("AC2a: fires on PostToolUse when transcript usage >= max_tokens", async () => {
    const h = buildHarness();
    const transcriptPath = writeTranscript([assistantLine(150_000)]);
    habits = [
      habit({
        path: "self.session-length",
        name: "length-guard",
        max_tokens: 100_000,
        action: { kind: "inject", hint: "context near limit — consider cycling" },
      }),
    ];

    const body = await post(h, postToolUse(h.sessionId, transcriptPath));
    expect(body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "context near limit — consider cycling",
      },
    });
    await teardown(h);
  });

  // AC2 — same check for UserPromptSubmit (session resumed without tool use).
  it("AC2b: fires on UserPromptSubmit when transcript usage >= max_tokens", async () => {
    const h = buildHarness();
    const transcriptPath = writeTranscript([assistantLine(150_000)]);
    habits = [
      habit({
        path: "self.session-length",
        name: "length-guard",
        max_tokens: 100_000,
        action: { kind: "inject", hint: "context near limit — consider cycling" },
      }),
    ];

    const body = await post(h, userPromptSubmit(h.sessionId, transcriptPath));
    expect(body).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "context near limit — consider cycling",
      },
    });
    await teardown(h);
  });

  // AC2 — usage below threshold → {continue: true}.
  it("AC2c: stays quiet when transcript usage < max_tokens", async () => {
    const h = buildHarness();
    const transcriptPath = writeTranscript([assistantLine(50_000)]);
    habits = [
      habit({
        path: "self.session-length",
        name: "length-guard",
        max_tokens: 100_000,
        action: { kind: "inject", hint: "context near limit" },
      }),
    ];

    const body = await post(h, postToolUse(h.sessionId, transcriptPath));
    expect(body).toEqual({ continue: true });
    await teardown(h);
  });

  // AC3 — one-shot latch: after a fire the same session does not re-fire.
  it("AC3: subsequent PostToolUse in same session does not re-fire after latch", async () => {
    const h = buildHarness();
    const transcriptPath = writeTranscript([assistantLine(150_000)]);
    habits = [
      habit({
        path: "self.session-length",
        name: "length-guard",
        max_tokens: 100_000,
        action: { kind: "inject", hint: "context near limit" },
      }),
    ];

    const first = await post(h, postToolUse(h.sessionId, transcriptPath));
    expect(first).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "context near limit",
      },
    });

    // Second event in the same session: latch should suppress re-fire.
    const second = await post(h, postToolUse(h.sessionId, transcriptPath));
    expect(second).toEqual({ continue: true });
    await teardown(h);
  });

  // AC3 — different session fires independently.
  it("AC3: a different session fires independently of the first session's latch", async () => {
    const h = buildHarness();
    const transcriptPath = writeTranscript([assistantLine(150_000)]);
    habits = [
      habit({
        path: "self.session-length",
        name: "length-guard",
        max_tokens: 100_000,
        action: { kind: "inject", hint: "context near limit" },
      }),
    ];

    // Fire session 1.
    await post(h, postToolUse(h.sessionId, transcriptPath));

    // Register a second session in the same server/latch store.
    const db2 = h.db;
    const workspaces2 = createWorkspaceStore(db2);
    const roles2 = createRoleStore(db2);
    const agents2 = createAgentStore(db2);
    const sessions2 = createSessionStore(db2);
    const workspace2 = workspaces2.create({ name: "ws2", repo_path: repoPath });
    const role2 = roles2.create({ name: `role2-${randomUUID()}`, persistent: false });
    const agent2 = agents2.create({ workspace_id: workspace2.id, role_id: role2.id });
    const sessionId2 = randomUUID();
    sessions2.create({
      id: sessionId2,
      agent_id: agent2.id,
      workspace_id: workspace2.id,
      role_id: role2.id,
      pid: 9001,
    });

    // Session 2 should fire independently.
    const second = await post(h, postToolUse(sessionId2, transcriptPath));
    expect(second).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "context near limit",
      },
    });
    await teardown(h);
  });

  // AC4 — bounded tail read: inject a counting reader, assert it is called
  // exactly once per hook event. The reader invocation count proves the habit
  // evaluator consults the transcript rather than skipping it.
  it("AC4: transcript tail reader is invoked exactly once per qualifying hook event", async () => {
    const h = buildHarness();
    const transcriptPath = writeTranscript([assistantLine(150_000)]);
    habits = [
      habit({
        path: "self.session-length",
        name: "length-guard",
        max_tokens: 100_000,
        action: { kind: "inject", hint: "context near limit" },
      }),
    ];

    readTranscriptTailCalls = 0;
    await post(h, postToolUse(h.sessionId, transcriptPath));
    expect(readTranscriptTailCalls).toBe(1);
    await teardown(h);
  });

  // AC5 — zero-cost when unconfigured: no session-length habit → zero
  // transcript reads on the hook path.
  it("AC5: no transcript read when no session-length habit is configured", async () => {
    const h = buildHarness();
    // Only a non-session-length habit configured.
    habits = [
      habit({
        path: "self.tool-use",
        name: "bash-note",
        match: "Bash",
        action: { kind: "inject", hint: "quote your paths" },
      }),
    ];
    const transcriptPath = writeTranscript([assistantLine(200_000)]);

    readTranscriptTailCalls = 0;
    await post(h, postToolUse(h.sessionId, transcriptPath));
    expect(readTranscriptTailCalls).toBe(0);
    await teardown(h);
  });

  // AC7 — composer interplay: session-length hint + co-firing quiet drain item
  // both appear in one hookSpecificOutput wrapper (rides the #594 AC3 composer).
  it("AC7: session-length hint and a quiet drain notification both appear in one additionalContext", async () => {
    const h = buildHarness();
    const transcriptPath = writeTranscript([assistantLine(150_000)]);
    habits = [
      habit({
        path: "self.session-length",
        name: "length-guard",
        max_tokens: 100_000,
        action: { kind: "inject", hint: "context near limit — consider cycling" },
      }),
    ];

    // Seed a quiet notification for this agent so the #594 drain fires too.
    const notifications = createNotificationStore(h.db);
    const quietReq: CreateNotification = {
      type: "reminder",
      category: "durable",
      recipient: { kind: "agent", agent_id: h.agentId },
      priority: "low",
      payload: { body: "don't forget to log your decision", tag: { kind: "message" } },
      provenance: { source_kind: "test" },
      delivery_mode: "quiet",
    };
    notifications.create(quietReq, 0);

    const body = await post(h, postToolUse(h.sessionId, transcriptPath)) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    expect(body.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    // Both the session-length hint and the quiet drain item must be present.
    const ctx = body.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("context near limit — consider cycling");
    expect(ctx).toContain("don't forget to log your decision");
    await teardown(h);
  });
});
