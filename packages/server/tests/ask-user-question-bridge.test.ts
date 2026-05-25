import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodePanelAnswer,
  type AgentQuestion,
  type PreToolUsePayload,
} from "@clobber/shared";
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

const SINGLE_QUESTION = {
  question: "Pick a release strategy",
  header: "Release",
  options: [
    { label: "Roll forward", description: "Ship the fix on top of the current release" },
    { label: "Roll back", description: "Revert to the previous tag", preview: "git revert v1.2" },
  ],
  multiSelect: false,
};

function hookPayload(
  sessionId: string,
  questions: readonly unknown[] = [SINGLE_QUESTION],
): Record<string, unknown> {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "tool-use-1",
    tool_input: { questions },
  };
}

async function waitForOpenQuestion(
  h: Harness,
  sessionId: string,
  matching?: (q: AgentQuestion) => boolean,
): Promise<AgentQuestion> {
  for (let i = 0; i < 200; i++) {
    const open = h.questions.getOpenForSession(sessionId);
    if (open !== null && (matching === undefined || matching(open))) return open;
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
  const body = JSON.parse(rawJson) as { hookSpecificOutput: BridgeOutput };
  return body.hookSpecificOutput;
}

interface AnsweredCtx {
  status: string;
  answers: Array<{
    question: string;
    header?: string;
    multi_select: boolean;
    selections: Array<{ label: string; option_index: number | null }>;
    raw: string;
    notes?: string;
  }>;
}

describe("PreToolUse bridge for AskUserQuestion", () => {
  it("single question: preserves rich options (incl preview) and round-trips a bare answer", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const hookPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: hookPayload(sessionId),
    });

    const opened = await waitForOpenQuestion(h, sessionId);
    expect(opened.questions).toHaveLength(1);
    expect(opened.questions[0]!.options).toEqual([
      { label: "Roll forward", description: "Ship the fix on top of the current release" },
      { label: "Roll back", description: "Revert to the previous tag", preview: "git revert v1.2" },
    ]);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: opened.id, answer: "Roll forward" },
    });

    const out = parseBridgeOutput((await hookPromise).body);
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toBe(ASK_BRIDGE_REASON_STAMP);
    const ctx = JSON.parse(out.additionalContext) as AnsweredCtx;
    expect(ctx).toEqual({
      status: "answered",
      answers: [
        {
          question: "Pick a release strategy",
          header: "Release",
          multi_select: false,
          selections: [{ label: "Roll forward", option_index: 0 }],
          raw: "Roll forward",
        },
      ],
    });
    await teardown(h);
  });

  it("single question: a free-text answer maps to option_index=null", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);
    const hookPromise = h.server.inject({ method: "POST", url: "/hook", payload: hookPayload(sessionId) });
    const opened = await waitForOpenQuestion(h, sessionId);
    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: opened.id, answer: "rebase instead" },
    });
    const ctx = JSON.parse(parseBridgeOutput((await hookPromise).body).additionalContext) as AnsweredCtx;
    expect(ctx.answers[0]!.selections).toEqual([{ label: "rebase instead", option_index: null }]);
    await teardown(h);
  });

  it("three-question panel: stores ONE row carrying all three, no flattening", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const questions = [
      { question: "First?", header: "First", options: [{ label: "a" }, { label: "b" }], multiSelect: false },
      { question: "Second?", header: "Second", options: [{ label: "x", preview: "<diagram x>" }, { label: "y" }], multiSelect: false },
      { question: "Third?", header: "Third", options: [{ label: "1" }, { label: "2" }], multiSelect: false },
    ];
    const hookPromise = h.server.inject({ method: "POST", url: "/hook", payload: hookPayload(sessionId, questions) });

    const opened = await waitForOpenQuestion(h, sessionId);
    expect(opened.questions).toHaveLength(3);
    expect(opened.questions[1]!.options![0]!.preview).toBe("<diagram x>");

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: opened.id, answer: encodePanelAnswer([{ raw: "a" }, { raw: "x" }, { raw: "1" }]) },
    });

    const ctx = JSON.parse(parseBridgeOutput((await hookPromise).body).additionalContext) as AnsweredCtx;
    expect(ctx.status).toBe("answered");
    expect(ctx.answers.map((a) => a.question)).toEqual(["First?", "Second?", "Third?"]);
    expect(ctx.answers.map((a) => a.selections[0]!.option_index)).toEqual([0, 0, 0]);
    expect(ctx.answers[1]!.raw).toBe("x");
    await teardown(h);
  });

  it("per-question multiSelect is honored independently across the panel", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const questions = [
      { question: "Which checks to skip?", header: "Skip", multiSelect: true, options: [{ label: "lint" }, { label: "type-check" }, { label: "tests" }] },
      { question: "Which db?", header: "DB", multiSelect: false, options: [{ label: "sqlite" }, { label: "postgres" }] },
    ];
    const hookPromise = h.server.inject({ method: "POST", url: "/hook", payload: hookPayload(sessionId, questions) });
    const opened = await waitForOpenQuestion(h, sessionId);
    expect(opened.questions[0]!.multi_select).toBe(true);
    expect(opened.questions[1]!.multi_select).toBe(false);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: {
        question_id: opened.id,
        answer: encodePanelAnswer([
          { raw: JSON.stringify(["lint", "tests"]) },
          { raw: "postgres", notes: "managed instance please" },
        ]),
      },
    });

    const ctx = JSON.parse(parseBridgeOutput((await hookPromise).body).additionalContext) as AnsweredCtx;
    expect(ctx.answers[0]!.selections).toEqual([
      { label: "lint", option_index: 0 },
      { label: "tests", option_index: 2 },
    ]);
    expect(ctx.answers[1]!.selections).toEqual([{ label: "postgres", option_index: 1 }]);
    expect(ctx.answers[1]!.notes).toBe("managed instance please");
    await teardown(h);
  });

  it("rejects a partial answer that does not cover every question", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);
    const questions = [
      { question: "First?", header: "First", options: [{ label: "a" }, { label: "b" }], multiSelect: false },
      { question: "Second?", header: "Second", options: [{ label: "x" }, { label: "y" }], multiSelect: false },
    ];
    const hookPromise = h.server.inject({ method: "POST", url: "/hook", payload: hookPayload(sessionId, questions) });
    const opened = await waitForOpenQuestion(h, sessionId);

    // A two-question panel answered with a one-entry envelope is a partial answer.
    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: opened.id, answer: JSON.stringify({ answers: [{ raw: "a" }] }) },
    });

    const res = await hookPromise;
    expect(res.statusCode).toBe(500);
    await teardown(h);
  });

  it("returns status=timed_out echoing every question when no answer arrives", async () => {
    const h = buildHarness(50);
    const { sessionId } = seedSession(h);
    const questions = [
      { question: "First?", header: "First", options: [{ label: "a" }, { label: "b" }], multiSelect: false },
      { question: "Second?", header: "Second", options: [{ label: "x" }, { label: "y" }], multiSelect: true },
    ];
    const res = await h.server.inject({ method: "POST", url: "/hook", payload: hookPayload(sessionId, questions) });
    const ctx = JSON.parse(parseBridgeOutput(res.body).additionalContext) as {
      status: string;
      questions: Array<{ question: string; header?: string; multi_select: boolean }>;
    };
    expect(ctx).toEqual({
      status: "timed_out",
      questions: [
        { question: "First?", header: "First", multi_select: false },
        { question: "Second?", header: "Second", multi_select: true },
      ],
    });
    expect(h.questions.getOpenForSession(sessionId)).toBeNull();
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
      } satisfies PreToolUsePayload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    expect(h.questions.getOpenForSession(sessionId)).toBeNull();
    await teardown(h);
  });

  it("returns status=cancelled when an in-flight bridge is superseded by a fresh call", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const firstPromise = h.server.inject({ method: "POST", url: "/hook", payload: hookPayload(sessionId) });
    await waitForOpenQuestion(h, sessionId);

    const secondPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: hookPayload(sessionId, [
        { question: "Replacement?", header: "Again", options: [{ label: "yes" }, { label: "no" }], multiSelect: false },
      ]),
    });

    const firstCtx = JSON.parse(parseBridgeOutput((await firstPromise).body).additionalContext) as { status: string };
    expect(firstCtx.status).toBe("cancelled");

    const second = await waitForOpenQuestion(h, sessionId, (q) => q.questions[0]!.question === "Replacement?");
    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: second.id, answer: "yes" },
    });
    await secondPromise;
    await teardown(h);
  });
});
