import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HabitSchema, type Habit, type HookPayload } from "@clobber/shared";
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

function habit(partial: Record<string, unknown>): Habit {
  return HabitSchema.parse(partial);
}

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly sessionId: string;
}

let repoPath: string;
// Mutated per test before the request; the resolver/sampler read these live.
let habits: readonly Habit[] = [];
let randomValue = 0;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-habit-recv-"));
  habits = [];
  randomValue = 0;
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
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
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    resolveSessionHabits: () => habits,
    habitRandom: () => randomValue,
    habitRunBash: (command) => `ran:${command}`,
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
  return { server, db, sessionId };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function envelope(sessionId: string): { session_id: string; transcript_path: string; cwd: string; permission_mode: "bypassPermissions" } {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: repoPath,
    permission_mode: "bypassPermissions",
  };
}

async function post(h: Harness, payload: HookPayload): Promise<unknown> {
  const res = await h.server.inject({ method: "POST", url: "/hook", payload });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const preToolBash = (sid: string): HookPayload => ({
  ...envelope(sid),
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  tool_use_id: "toolu_x",
});

describe("self.* habit receiver (/hook)", () => {
  it("fires a matching self.tool-use inject habit as additionalContext", async () => {
    const h = buildHarness();
    habits = [habit({ path: "self.tool-use", name: "n", match: "Bash", action: { kind: "inject", hint: "quote your paths" } })];

    const body = await post(h, preToolBash(h.sessionId));
    expect(body).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "quote your paths" },
    });
    await teardown(h);
  });

  it("does not fire when `match` excludes the tool — baseline IPC continues", async () => {
    const h = buildHarness();
    habits = [habit({ path: "self.tool-use", name: "n", match: "Bash", action: { kind: "inject", hint: "h" } })];

    const body = await post(h, {
      ...envelope(h.sessionId),
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "x" },
      tool_use_id: "toolu_y",
    });
    expect(body).toEqual({ continue: true });
    await teardown(h);
  });

  it("matches a self.session-message habit's regex against the prompt", async () => {
    const h = buildHarness();
    habits = [habit({ path: "self.session-message", name: "n", match: "deploy", action: { kind: "inject", hint: "run CI first" } })];

    const fired = await post(h, { ...envelope(h.sessionId), hook_event_name: "UserPromptSubmit", prompt: "let's deploy now" });
    expect(fired).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "run CI first" },
    });

    const quiet = await post(h, { ...envelope(h.sessionId), hook_event_name: "UserPromptSubmit", prompt: "hello there" });
    expect(quiet).toEqual({ continue: true });
    await teardown(h);
  });

  it("`rand` gates: fires when sample < rand, stays quiet when sample >= rand", async () => {
    const h = buildHarness();
    habits = [habit({ path: "self.tool-use", name: "n", match: "Bash", rand: 0.5, action: { kind: "inject", hint: "h" } })];

    randomValue = 0.9;
    expect(await post(h, preToolBash(h.sessionId))).toEqual({ continue: true });

    randomValue = 0.1;
    expect(await post(h, preToolBash(h.sessionId))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "h" },
    });
    await teardown(h);
  });

  it("appends `bash` stdout to the hint", async () => {
    const h = buildHarness();
    habits = [habit({ path: "self.tool-use", name: "n", match: "Bash", action: { kind: "inject", hint: "context:", bash: "git status" } })];

    expect(await post(h, preToolBash(h.sessionId))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "context:\nran:git status" },
    });
    await teardown(h);
  });

  it("a Stop event with no self.stop habit leaves baseline IPC intact", async () => {
    const h = buildHarness();
    habits = [habit({ path: "self.tool-use", name: "n", match: "Bash", action: { kind: "inject", hint: "h" } })];
    expect(await post(h, { ...envelope(h.sessionId), hook_event_name: "Stop" })).toEqual({ continue: true });
    await teardown(h);
  });
});
