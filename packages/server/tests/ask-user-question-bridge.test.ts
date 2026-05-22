import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolUsePayload } from "@clobber/shared";
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
import { ASK_BRIDGE_REASON_STAMP } from "../src/ask-user-question-bridge.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly agents: ReturnType<typeof createAgentStore>;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly questions: ReturnType<typeof createAgentQuestionStore>;
}

function buildHarness(askTimeoutMs = 5_000): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const questions = createAgentQuestionStore(db);
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
    agentQuestions: questions,
    agentQuestionWaiter: createAgentQuestionWaiter(),
    askTimeoutMs,
    spawner: () => stubSpawnedAgent({ pid: 9999 }),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, agents, sessions, questions };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-ask-bridge-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function seedSession(h: Harness): { sessionId: string } {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({ name: "worker", persistent: false });
  const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    pid: 1,
  });
  return { sessionId };
}

function askUserQuestionHookPayload(
  sessionId: string,
  overrides?: Partial<PreToolUsePayload["tool_input"]>,
): Record<string, unknown> {
  const baseInput = {
    questions: [
      {
        question: "Pick a release strategy",
        header: "Release",
        options: [
          { label: "Roll forward", description: "Ship the fix on top of the current release" },
          { label: "Roll back", description: "Revert to the previous tag", preview: "git revert v1.2" },
        ],
        multiSelect: false,
      },
    ],
  };
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "tool-use-1",
    tool_input: overrides === undefined ? baseInput : { ...baseInput, ...overrides },
  };
}

async function waitForOpenQuestion(
  h: Harness,
  sessionId: string,
  matching?: (q: { readonly question: string }) => boolean,
): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const open = h.questions.getOpenForSession(sessionId);
    if (open !== null && (matching === undefined || matching(open))) {
      return open.id;
    }
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for open question");
}

interface BridgeOutput {
  readonly hookEventName: string;
  readonly permissionDecision: string;
  readonly permissionDecisionReason: string;
  readonly additionalContext: string;
}

function parseBridgeOutput(rawJson: string): BridgeOutput {
  const body = JSON.parse(rawJson) as {
    hookSpecificOutput: BridgeOutput;
  };
  return body.hookSpecificOutput;
}

describe("PreToolUse bridge for AskUserQuestion", () => {
  it("returns a structured answered context with selection index and minimal reason stamp", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const hookPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId),
    });

    const openId = await waitForOpenQuestion(h, sessionId);
    const opened = h.questions.get(openId)!;
    expect(opened.question).toBe("Pick a release strategy");
    expect(opened.header).toBe("Release");
    expect(opened.multi_select).toBe(false);
    expect(opened.options).toEqual([
      { label: "Roll forward", description: "Ship the fix on top of the current release" },
      { label: "Roll back", description: "Revert to the previous tag", preview: "git revert v1.2" },
    ]);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: "Roll forward" },
    });

    const hookRes = await hookPromise;
    expect(hookRes.statusCode).toBe(200);
    const out = parseBridgeOutput(hookRes.body);
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toBe(ASK_BRIDGE_REASON_STAMP);

    const ctx = JSON.parse(out.additionalContext) as {
      status: string;
      question: string;
      header?: string;
      multi_select: boolean;
      selections: Array<{ label: string; option_index: number | null }>;
      raw: string;
    };
    expect(ctx).toEqual({
      status: "answered",
      question: "Pick a release strategy",
      header: "Release",
      multi_select: false,
      selections: [{ label: "Roll forward", option_index: 0 }],
      raw: "Roll forward",
    });

    await teardown(h);
  });

  it("marks single-select free-text answers with option_index=null", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const hookPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId),
    });

    const openId = await waitForOpenQuestion(h, sessionId);
    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: "rebase instead" },
    });

    const out = parseBridgeOutput((await hookPromise).body);
    const ctx = JSON.parse(out.additionalContext) as {
      selections: Array<{ label: string; option_index: number | null }>;
      raw: string;
    };
    expect(ctx.selections).toEqual([{ label: "rebase instead", option_index: null }]);
    expect(ctx.raw).toBe("rebase instead");
    await teardown(h);
  });

  it("multi-select: parses a JSON-array answer into ordered selections with indices", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const hookPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId, {
        questions: [
          {
            question: "Which checks to skip?",
            header: "Skip",
            multiSelect: true,
            options: [
              { label: "lint" },
              { label: "type-check" },
              { label: "tests" },
            ],
          },
        ],
      }),
    });

    const openId = await waitForOpenQuestion(h, sessionId);
    const opened = h.questions.get(openId)!;
    expect(opened.multi_select).toBe(true);
    expect(opened.header).toBe("Skip");

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: JSON.stringify(["lint", "tests"]) },
    });

    const out = parseBridgeOutput((await hookPromise).body);
    const ctx = JSON.parse(out.additionalContext) as {
      status: string;
      multi_select: boolean;
      selections: Array<{ label: string; option_index: number | null }>;
      raw: string;
    };
    expect(ctx.status).toBe("answered");
    expect(ctx.multi_select).toBe(true);
    expect(ctx.selections).toEqual([
      { label: "lint", option_index: 0 },
      { label: "tests", option_index: 2 },
    ]);
    expect(ctx.raw).toBe('["lint","tests"]');
    await teardown(h);
  });

  it("multi-select: a non-JSON free-text answer is treated as a single label with null index", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const hookPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId, {
        questions: [
          {
            question: "Which checks to skip?",
            header: "Skip",
            multiSelect: true,
            options: [
              { label: "lint" },
              { label: "type-check" },
              { label: "tests" },
            ],
          },
        ],
      }),
    });

    const openId = await waitForOpenQuestion(h, sessionId);
    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: "skip none, run all" },
    });

    const out = parseBridgeOutput((await hookPromise).body);
    const ctx = JSON.parse(out.additionalContext) as {
      selections: Array<{ label: string; option_index: number | null }>;
    };
    expect(ctx.selections).toEqual([
      { label: "skip none, run all", option_index: null },
    ]);
    await teardown(h);
  });

  it("returns status=timed_out in the structured context (with the question echoed) when no answer arrives", async () => {
    const h = buildHarness(50);
    const { sessionId } = seedSession(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId),
    });
    expect(res.statusCode).toBe(200);
    const out = parseBridgeOutput(res.body);
    const ctx = JSON.parse(out.additionalContext) as {
      status: string;
      question: string;
      header?: string;
      multi_select: boolean;
    };
    expect(ctx).toEqual({
      status: "timed_out",
      question: "Pick a release strategy",
      header: "Release",
      multi_select: false,
    });
    expect(h.questions.getOpenForSession(sessionId)).toBeNull();
    await teardown(h);
  });

  it("flags multi-question lossy flatten via dropped_question_count + notes; answered status still set", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const hookPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId, {
        questions: [
          {
            question: "First?",
            header: "First",
            options: [{ label: "a" }, { label: "b" }],
            multiSelect: false,
          },
          {
            question: "Second?",
            header: "Second",
            options: [{ label: "x" }, { label: "y" }],
            multiSelect: false,
          },
          {
            question: "Third?",
            header: "Third",
            options: [{ label: "1" }, { label: "2" }],
            multiSelect: false,
          },
        ],
      }),
    });

    const openId = await waitForOpenQuestion(h, sessionId);
    expect(h.questions.get(openId)!.question).toBe("First?");

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: "a" },
    });

    const out = parseBridgeOutput((await hookPromise).body);
    const ctx = JSON.parse(out.additionalContext) as {
      status: string;
      dropped_question_count: number;
      notes: string[];
      selections: Array<{ label: string; option_index: number | null }>;
    };
    expect(ctx.status).toBe("answered");
    expect(ctx.dropped_question_count).toBe(2);
    expect(ctx.notes[0]).toContain("2 extra AskUserQuestion questions");
    expect(ctx.selections).toEqual([{ label: "a", option_index: 0 }]);
    await teardown(h);
  });

  it("does not intercept tools other than AskUserQuestion", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: sessionId,
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool-use-2",
        tool_input: { file_path: "/tmp/x.txt" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    expect(h.questions.getOpenForSession(sessionId)).toBeNull();
    await teardown(h);
  });

  it("returns status=cancelled when an in-flight bridge is superseded by a fresh AskUserQuestion call", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const firstPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId),
    });

    await waitForOpenQuestion(h, sessionId);

    const secondPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId, {
        questions: [
          {
            question: "Replacement?",
            header: "Again",
            options: [{ label: "yes" }, { label: "no" }],
            multiSelect: false,
          },
        ],
      }),
    });

    const firstOut = parseBridgeOutput((await firstPromise).body);
    const firstCtx = JSON.parse(firstOut.additionalContext) as { status: string };
    expect(firstCtx.status).toBe("cancelled");

    const secondOpenId = await waitForOpenQuestion(
      h,
      sessionId,
      (q) => q.question === "Replacement?",
    );
    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: secondOpenId, answer: "yes" },
    });
    await secondPromise;

    await teardown(h);
  });
});
