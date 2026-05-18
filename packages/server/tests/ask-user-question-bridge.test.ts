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
import {
  ASK_BRIDGE_CANCEL_NOTICE,
  ASK_BRIDGE_TIMEOUT_NOTICE,
} from "../src/ask-user-question-bridge.ts";
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

describe("PreToolUse bridge for AskUserQuestion", () => {
  it("intercepts the call, creates a question row, and returns the answer as deny+additionalContext", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const hookPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId),
    });

    let openId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const open = h.questions.getOpenForSession(sessionId);
      if (open !== null) {
        openId = open.id;
        break;
      }
      await Bun.sleep(5);
    }
    expect(openId).toBeDefined();

    const opened = h.questions.get(openId!)!;
    expect(opened.question).toBe("Pick a release strategy");
    expect(opened.header).toBe("Release");
    expect(opened.multi_select).toBe(false);
    expect(opened.options).toEqual([
      { label: "Roll forward", description: "Ship the fix on top of the current release" },
      { label: "Roll back", description: "Revert to the previous tag", preview: "git revert v1.2" },
    ]);

    const answerRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: "Roll forward" },
    });
    expect(answerRes.statusCode).toBe(200);

    const hookRes = await hookPromise;
    expect(hookRes.statusCode).toBe(200);
    const body = hookRes.json() as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
        additionalContext: string;
      };
    };
    expect(body.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("Roll forward");
    expect(body.hookSpecificOutput.additionalContext).toContain("Pick a release strategy");
    expect(body.hookSpecificOutput.additionalContext).toContain("Roll forward");

    await teardown(h);
  });

  it("preserves multi-select and header through to the stored question", async () => {
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

    let openId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const open = h.questions.getOpenForSession(sessionId);
      if (open !== null) {
        openId = open.id;
        break;
      }
      await Bun.sleep(5);
    }
    expect(openId).toBeDefined();
    const opened = h.questions.get(openId!)!;
    expect(opened.multi_select).toBe(true);
    expect(opened.header).toBe("Skip");
    expect(opened.options).toEqual([
      { label: "lint" },
      { label: "type-check" },
      { label: "tests" },
    ]);

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: "lint,tests" },
    });
    await hookPromise;
    await teardown(h);
  });

  it("returns a structured timeout notice when no answer arrives before the deadline", async () => {
    const h = buildHarness(50);
    const { sessionId } = seedSession(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe(
      ASK_BRIDGE_TIMEOUT_NOTICE,
    );
    expect(h.questions.getOpenForSession(sessionId)).toBeNull();
    await teardown(h);
  });

  it("flags multi-question lossy flatten in the reason when more than one question is sent", async () => {
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
        ],
      }),
    });

    let openId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const open = h.questions.getOpenForSession(sessionId);
      if (open !== null) {
        openId = open.id;
        break;
      }
      await Bun.sleep(5);
    }
    expect(openId).toBeDefined();
    expect(h.questions.get(openId!)!.question).toBe("First?");

    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: openId, answer: "a" },
    });

    const res = await hookPromise;
    const body = res.json() as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("a");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain(
      "extra AskUserQuestion questions beyond the first were dropped",
    );
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

  it("returns a cancel notice when an in-flight bridge is superseded by a fresh AskUserQuestion call", async () => {
    const h = buildHarness();
    const { sessionId } = seedSession(h);

    const firstPromise = h.server.inject({
      method: "POST",
      url: "/hook",
      payload: askUserQuestionHookPayload(sessionId),
    });

    for (let i = 0; i < 100; i++) {
      if (h.questions.getOpenForSession(sessionId) !== null) break;
      await Bun.sleep(5);
    }

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

    const firstRes = await firstPromise;
    const firstBody = firstRes.json() as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(firstBody.hookSpecificOutput.permissionDecisionReason).toBe(
      ASK_BRIDGE_CANCEL_NOTICE,
    );

    let secondOpenId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const open = h.questions.getOpenForSession(sessionId);
      if (open !== null && open.question === "Replacement?") {
        secondOpenId = open.id;
        break;
      }
      await Bun.sleep(5);
    }
    expect(secondOpenId).toBeDefined();
    await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/answer`,
      payload: { question_id: secondOpenId, answer: "yes" },
    });
    await secondPromise;

    await teardown(h);
  });
});
