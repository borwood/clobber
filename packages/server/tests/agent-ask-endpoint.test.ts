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
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  questions: ReturnType<typeof createAgentQuestionStore>;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(askTimeoutMs = 5_000): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const agentStatuses = createAgentStatusStore(db);
  const questions = createAgentQuestionStore(db);
  const questionWaiter = createAgentQuestionWaiter();
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
    store: createEventStore(db),
    workspaces,
    roles,

    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens,
    agentStatuses,
    agentQuestions: questions,
    agentQuestionWaiter: questionWaiter,
    askTimeoutMs,
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens, questions };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface BootedAgent {
  workspaceId: string;
  sessionId: string;
  token: string;
  roleId: string;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-ask-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function bootAgent(h: Harness): Promise<BootedAgent> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string };
  const token = h.tokens.mint(body.session_id);
  return {
    workspaceId: ws.id,
    sessionId: body.session_id,
    token,
    roleId: role.id,
  };
}

describe("POST /agent/ask", () => {
  it("returns 401 without a bearer token", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/ask",
      payload: { question: "ok?" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 400 when question is missing or empty", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "" },
    });
    expect(res.statusCode).toBe(400);
    await teardown(h);
  });

  it("blocks until /sessions/:id/answer arrives, then returns the answer", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    // Agent asks; promise must not resolve until the human answers.
    const askPromise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "ship?", options: ["yes", "no"] },
    });

    // Wait for the question row to appear (proves the route registered the question).
    let openId: string | undefined;
    for (let i = 0; i < 50; i++) {
      const open = h.questions.getOpenForSession(boot.sessionId);
      if (open !== null) {
        openId = open.id;
        break;
      }
      await Bun.sleep(5);
    }
    expect(openId).toBeDefined();

    const answerRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${boot.sessionId}/answer`,
      payload: { question_id: openId, answer: "yes" },
    });
    expect(answerRes.statusCode).toBe(200);

    const askRes = await askPromise;
    expect(askRes.statusCode).toBe(200);
    expect(askRes.json() as unknown).toEqual({
      resolution: "answered",
      answer: "yes",
    });

    // Question row reflects the resolved state.
    const finalRow = h.questions.get(openId!);
    expect(finalRow!.status).toBe("answered");
    expect(finalRow!.answer).toBe("yes");
    await teardown(h);
  });

  it("returns a structured timeout response when the deadline passes", async () => {
    const h = buildHarness(50);
    const boot = await bootAgent(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "anyone home?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ resolution: "timed_out" });

    // Row was flipped to timed_out so the UI doesn't show a stale prompt.
    const openAfter = h.questions.getOpenForSession(boot.sessionId);
    expect(openAfter).toBeNull();
    await teardown(h);
  });

  it("supersedes a pre-existing open question for the same session", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    // Q1 starts and the agent moves on without waiting for an answer.
    const q1Promise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "first?" },
    });
    for (let i = 0; i < 50; i++) {
      if (h.questions.getOpenForSession(boot.sessionId) !== null) break;
      await Bun.sleep(5);
    }

    // Q2 arrives for the same session — must cancel Q1 so the human can't
    // accidentally answer the wrong one.
    const q2Promise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "second?" },
    });

    // Q1's blocking call resolves with cancelled.
    const q1Res = await q1Promise;
    expect(q1Res.statusCode).toBe(200);
    expect(q1Res.json() as unknown).toEqual({ resolution: "cancelled" });

    // Wait for Q2's row to land.
    let q2Open: { id: string; question: string } | null = null;
    for (let i = 0; i < 50; i++) {
      const open = h.questions.getOpenForSession(boot.sessionId);
      if (open !== null && open.question === "second?") {
        q2Open = open;
        break;
      }
      await Bun.sleep(5);
    }
    expect(q2Open).not.toBeNull();

    // The widget query returns Q2 only — Q1 is gone.
    const summariesRes = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${boot.workspaceId}`,
    });
    const summaries = summariesRes.json() as Array<{
      session_id: string;
      open_question?: { id: string; question: string };
    }>;
    const own = summaries.find((s) => s.session_id === boot.sessionId)!;
    expect(own.open_question?.question).toBe("second?");

    // Answering Q2 resolves the in-flight call.
    await h.server.inject({
      method: "POST",
      url: `/sessions/${boot.sessionId}/answer`,
      payload: { question_id: q2Open!.id, answer: "ok" },
    });
    const q2Res = await q2Promise;
    expect(q2Res.statusCode).toBe(200);
    expect(q2Res.json() as unknown).toEqual({
      resolution: "answered",
      answer: "ok",
    });

    // No leftover open question after answering Q2.
    expect(h.questions.getOpenForSession(boot.sessionId)).toBeNull();
    await teardown(h);
  });

  it("returns resolution=cancelled if the session is ended while the question is open", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const askPromise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "long-running?" },
    });

    // Wait for the row to land before ending.
    for (let i = 0; i < 50; i++) {
      if (h.questions.getOpenForSession(boot.sessionId) !== null) break;
      await Bun.sleep(5);
    }

    await h.server.inject({
      method: "POST",
      url: `/sessions/${boot.sessionId}/end`,
    });

    const askRes = await askPromise;
    expect(askRes.statusCode).toBe(200);
    expect(askRes.json() as unknown).toEqual({ resolution: "cancelled" });

    await teardown(h);
  });
});

describe("POST /sessions/:id/answer", () => {
  it("returns 404 when the session is unknown", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/sessions/missing/answer",
      payload: { question_id: "q", answer: "x" },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 404 when the question_id belongs to a different session", async () => {
    const h = buildHarness();
    const a = await bootAgent(h);

    // Open a question on agent A.
    const askPromise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { question: "?" },
    });
    for (let i = 0; i < 50; i++) {
      if (h.questions.getOpenForSession(a.sessionId) !== null) break;
      await Bun.sleep(5);
    }
    const open = h.questions.getOpenForSession(a.sessionId)!;

    // Spawn a second agent to get a session id we can mismatch against.
    const secondRole = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(a.workspaceId, secondRole.id, 5);
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: a.workspaceId, role_id: secondRole.id, prompt: "go" },
    });
    const otherId = (spawnRes.json() as { session_id: string }).session_id;

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${otherId}/answer`,
      payload: { question_id: open.id, answer: "x" },
    });
    expect(res.statusCode).toBe(404);

    // Cleanup the dangling ask.
    await h.server.inject({
      method: "POST",
      url: `/sessions/${a.sessionId}/answer`,
      payload: { question_id: open.id, answer: "ok" },
    });
    await askPromise;
    await teardown(h);
  });

  it("returns 409 when the question is already resolved", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const askPromise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "?" },
    });
    for (let i = 0; i < 50; i++) {
      if (h.questions.getOpenForSession(boot.sessionId) !== null) break;
      await Bun.sleep(5);
    }
    const open = h.questions.getOpenForSession(boot.sessionId)!;

    const first = await h.server.inject({
      method: "POST",
      url: `/sessions/${boot.sessionId}/answer`,
      payload: { question_id: open.id, answer: "yes" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.server.inject({
      method: "POST",
      url: `/sessions/${boot.sessionId}/answer`,
      payload: { question_id: open.id, answer: "no" },
    });
    expect(second.statusCode).toBe(409);

    await askPromise;
    await teardown(h);
  });
});

describe("GET /sessions surfaces open_question", () => {
  it("includes the open question on the asking session", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const askPromise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "merge?", options: ["yes", "no"] },
    });
    for (let i = 0; i < 50; i++) {
      if (h.questions.getOpenForSession(boot.sessionId) !== null) break;
      await Bun.sleep(5);
    }

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${boot.workspaceId}`,
    });
    expect(res.statusCode).toBe(200);
    const summaries = res.json() as Array<{
      session_id: string;
      open_question?: {
        id: string;
        question: string;
        options?: string[];
      };
    }>;
    const own = summaries.find((s) => s.session_id === boot.sessionId)!;
    expect(own.open_question).toBeDefined();
    expect(own.open_question!.question).toBe("merge?");
    expect(own.open_question!.options).toEqual(["yes", "no"]);

    // Cleanup
    await h.server.inject({
      method: "POST",
      url: `/sessions/${boot.sessionId}/answer`,
      payload: { question_id: own.open_question!.id, answer: "yes" },
    });
    await askPromise;
    await teardown(h);
  });

  it("omits open_question after the question is answered", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);

    const askPromise = h.server.inject({
      method: "POST",
      url: "/agent/ask",
      headers: { authorization: `Bearer ${boot.token}` },
      payload: { question: "?" },
    });
    for (let i = 0; i < 50; i++) {
      if (h.questions.getOpenForSession(boot.sessionId) !== null) break;
      await Bun.sleep(5);
    }
    const open = h.questions.getOpenForSession(boot.sessionId)!;
    await h.server.inject({
      method: "POST",
      url: `/sessions/${boot.sessionId}/answer`,
      payload: { question_id: open.id, answer: "yes" },
    });
    await askPromise;

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${boot.workspaceId}`,
    });
    const summaries = res.json() as Array<{
      session_id: string;
      open_question?: unknown;
    }>;
    const own = summaries.find((s) => s.session_id === boot.sessionId)!;
    expect(own.open_question).toBeUndefined();

    await teardown(h);
  });
});
