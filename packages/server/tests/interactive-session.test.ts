import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serializeUserMessage } from "@clobber/runtime";
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
import type { AgentSpawner } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";

interface StubAgent {
  readonly sessionId: string;
  readonly pid: number;
  readonly writes: string[];
  exit(code: number | null): Promise<void>;
}

interface SpawnControl {
  readonly spawner: AgentSpawner;
  readonly agents: StubAgent[];
}

function controlledSpawner(): SpawnControl {
  const agents: StubAgent[] = [];
  const resolvers = new Map<string, (code: number | null) => void>();
  let counter = 0;

  const spawner: AgentSpawner = (req) => {
    counter += 1;
    if (req.sessionId === undefined) throw new Error("test stub expects sessionId from spawn route");
    const sessionId = req.sessionId;
    const stdin = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => {
      writes.push(chunk.toString());
    });
    const exited = new Promise<number | null>((resolve) => {
      resolvers.set(sessionId, resolve);
    });
    const stub: StubAgent = {
      sessionId,
      pid: 2000 + counter,
      writes,
      async exit(code) {
        const r = resolvers.get(sessionId);
        if (r === undefined) throw new Error(`no live spawn for ${sessionId}`);
        r(code);
        resolvers.delete(sessionId);
        await new Promise<void>((res) => setTimeout(res, 0));
      },
    };
    agents.push(stub);
    return { sessionId, pid: stub.pid, exited, stdin, kill: () => {} };
  };

  return { spawner, agents };
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  agentQuestions: ReturnType<typeof createAgentQuestionStore>;
  control: SpawnControl;
  repoPaths: string[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agentsStore = createAgentStore(db);
  const sessions = createSessionStore(db);
  const agentQuestions = createAgentQuestionStore(db);
  const control = controlledSpawner();
  const server = createServer({
    db,
    store,
    workspaces,
    roles,

    roleVersions,
    workspaceRoles,
    agents: agentsStore,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions,
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: control.spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return {
    server,
    db,
    workspaces,
    roles,
    workspaceRoles,
    agents: agentsStore,
    sessions,
    agentQuestions,
    control,
    repoPaths: [],
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  for (const p of h.repoPaths) rmSync(p, { recursive: true, force: true });
}

interface Spawned {
  agent_id: string;
  session_id: string;
  pid: number;
}

async function seedAndSpawn(h: Harness, persistent = true): Promise<Spawned> {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-interactive-"));
  h.repoPaths.push(repoPath);
  const ws = h.workspaces.create({ name: `ws-${Math.random()}`, repo_path: repoPath });
  const role = h.roles.create({ name: "manager", persistent });
  h.workspaceRoles.setCeiling(ws.id, role.id, 1);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "initial", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Spawned;
}

function stopHook(sessionId: string) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: "/r",
    permission_mode: "default" as const,
    hook_event_name: "Stop" as const,
  };
}

async function fireStop(h: Harness, sessionId: string): Promise<void> {
  const res = await h.server.inject({
    method: "POST",
    url: "/hook",
    payload: stopHook(sessionId),
  });
  expect(res.statusCode).toBe(200);
}

describe("POST /sessions/:id/prompt — interactive sessions (issue #8)", () => {
  it("after Stop hook clears busy, prompt is written to the live child's stdin", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "hello again" },
    });
    expect(res.statusCode).toBe(200);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    expect(stub).toBeDefined();
    expect(stub!.writes.join("")).toBe(serializeUserMessage("hello again"));

    await teardown(h);
  });

  it("writes a prompt sent while busy directly to stdin — claude's native queue defers it (#367)", async () => {
    // #367 spike: claude's native stdin queue already defers a mid-thinking write
    // to a safe tool-result boundary (14/14, never poisons). The clobber inject
    // queue that held the write until Stop is removed; injectPrompt writes
    // straight through even while the session is busy (initial turn in flight).
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "while busy" },
    });
    expect(res.statusCode).toBe(200);

    // Written immediately — no clobber-side queue, no waiting for Stop.
    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id)!;
    expect(stub.writes.join("")).toBe(serializeUserMessage("while busy"));

    // Stop must not re-deliver: the queue + its Stop-flush are gone.
    await fireStop(h, spawned.session_id);
    expect(stub.writes.join("")).toBe(serializeUserMessage("while busy"));

    await teardown(h);
  });

  it("writes multiple prompts sent while busy directly, in send order (#367)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);

    const first = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "one" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "two" },
    });
    expect(second.statusCode).toBe(200);

    // Both written immediately, in order — native queue handles mid-turn deferral.
    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id)!;
    expect(stub.writes.join("")).toBe(
      serializeUserMessage("one") + serializeUserMessage("two"),
    );

    // Stop does not re-deliver.
    await fireStop(h, spawned.session_id);
    expect(stub.writes.join("")).toBe(
      serializeUserMessage("one") + serializeUserMessage("two"),
    );

    await teardown(h);
  });

  it("wraps the live-inject prompt in <clobber type=\"live-inject\"> when caller passes kind (#261)", async () => {
    // The composer (web `sendPrompt`) sends no `kind` so its turn lands bare —
    // the positive presence signal for a human-typed turn. A programmatic
    // caller (CLI, internal forwarder) passes `kind: "live-inject"` and the
    // serialize chokepoint wraps the content. Same /prompt endpoint, both
    // paths covered by the body schema's optional kind.
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "do the thing", kind: "live-inject" },
    });
    expect(res.statusCode).toBe(200);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id)!;
    expect(stub.writes.join("")).toBe(
      serializeUserMessage("do the thing", { kind: "live-inject" }),
    );

    await teardown(h);
  });

  it("rejects an unknown kind value (positive-invariant — enum-checked at the route)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "x", kind: "human" },
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });

  it("returns 404 for an unknown session id", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/00000000-0000-4000-8000-deadbeef0001/prompt`,
      payload: { prompt: "anything" },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 410 'session ended' once the child has exited (#12)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id)!;
    await stub.exit(0);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "after death" },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe("session ended");

    await teardown(h);
  });

  it("returns 410 'session ended' for a session whose row has ended_at, regardless of registry state (#12)", async () => {
    // Boot-reaper scenario: ended_at is set but the in-memory registry was
    // never populated (e.g. server restarted, the row is the orphan). The
    // prompt route must read the row, not just the registry, to decide
    // between 404 (never existed) and 410 (existed, now done).
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);
    h.sessions.markEnded(spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "after death" },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe("session ended");

    await teardown(h);
  });

  it("rejects empty prompt with 400", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "" },
    });
    expect(res.statusCode).toBe(400);
    await teardown(h);
  });

  it("multi-line prompts are accepted (JSON-encoded as a single turn)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    await fireStop(h, spawned.session_id);

    const multiline = "line one\nline two";
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: multiline },
    });
    expect(res.statusCode).toBe(200);

    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    expect(stub!.writes.join("")).toBe(serializeUserMessage(multiline));
    await teardown(h);
  });
});

describe("POST /sessions/:id/answer — late answer to a timed-out ask routes back (issue #183)", () => {
  function askQuestion(h: Harness, sessionId: string) {
    return h.agentQuestions.create({
      session_id: sessionId,
      questions: [
        {
          question: "Roll the milestone forward?",
          multi_select: false,
          options: [{ label: "Roll forward" }, { label: "Hold" }],
        },
      ],
    });
  }

  it("a timed-out question is still surfaced as open (so the widget stays actionable)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    const q = askQuestion(h, spawned.session_id);
    h.agentQuestions.timeout(q.id);

    const ws = h.sessions.get(spawned.session_id)!.workspace_id;
    const res = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws}`,
    });
    expect(res.statusCode).toBe(200);
    const summary = (res.json() as { session_id: string; open_question?: { id: string; status: string } }[]).find(
      (s) => s.session_id === spawned.session_id,
    );
    expect(summary!.open_question).toBeDefined();
    expect(summary!.open_question!.id).toBe(q.id);
    expect(summary!.open_question!.status).toBe("timed_out");

    await teardown(h);
  });

  it("routes a late answer to a busy session as an immediate direct write (#367/#183)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    const q = askQuestion(h, spawned.session_id);
    h.agentQuestions.timeout(q.id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/answer`,
      payload: { question_id: q.id, answer: "Roll forward" },
    });
    expect(res.statusCode).toBe(200);

    // The session is mid-turn, but the late answer is written straight to stdin
    // now — claude's native queue defers it to a safe boundary (#367), no clobber
    // queue. It rides the #252 delivery path, carrying both the original question
    // and the chosen answer so the agent can pick the thread back up.
    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    const written = stub!.writes.join("");
    expect(written).toContain("Roll the milestone forward?");
    expect(written).toContain("Roll forward");
    // The late-answer injection is provenance-tagged at the serialize chokepoint
    // so the agent (and the web transcript) read it as system-origin, not a
    // typed-by-human turn. (#261)
    const parsed = JSON.parse(written.trim()) as {
      message: { content: string };
    };
    expect(parsed.message.content).toContain(`<clobber type="ask-answer">`);

    // The row no longer presents as open — it is now answered, with the answer
    // recorded, so the widget stops surfacing on the next poll.
    const after = h.agentQuestions.get(q.id);
    expect(after!.status).toBe("answered");
    expect(after!.answer).toBe("Roll forward");

    await teardown(h);
  });

  it("a pending question answers via the waiter, not via injection", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    const q = askQuestion(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/answer`,
      payload: { question_id: q.id, answer: "Hold" },
    });
    expect(res.statusCode).toBe(200);

    // A still-pending ask resolves through the blocking waiter — nothing is
    // injected to stdin (the blocked agent reads the answer on its return path).
    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id);
    expect(stub!.writes.join("")).toBe("");
    const after = h.agentQuestions.get(q.id);
    expect(after!.status).toBe("answered");

    await teardown(h);
  });

  it("a late answer to an ended session reports the session is gone (no silent drop)", async () => {
    const h = buildHarness();
    const spawned = await seedAndSpawn(h);
    const q = askQuestion(h, spawned.session_id);
    h.agentQuestions.timeout(q.id);
    const stub = h.control.agents.find((a) => a.sessionId === spawned.session_id)!;
    await stub.exit(0);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/answer`,
      payload: { question_id: q.id, answer: "Roll forward" },
    });
    expect(res.statusCode).toBe(410);

    await teardown(h);
  });
});
