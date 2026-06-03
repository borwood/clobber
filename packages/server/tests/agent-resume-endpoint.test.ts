import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import type { AgentSpawnRequest } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  roles: ReturnType<typeof createRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  workspaceId: string;
  managerToken: string;
  workerToken: string;
  workerRoleId: string;
  resumeRequests: AgentSpawnRequest[];
  writesBySession: Map<string, string[]>;
  repoPath: string;
}

function buildHarness(): Harness {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-resume-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const ws = workspaces.create({ name: `ws-${randomUUID()}`, repo_path: repoPath });

  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager");
  const workerRole = roles.findInWorkspace(ws.id, "worker");
  if (managerRole === null || workerRole === null) throw new Error("roles not seeded");

  const resumeRequests: AgentSpawnRequest[] = [];
  // Capture per-session stdin so a test can assert what injectPrompt delivered
  // (and in what order) to a resumed child.
  const writesBySession = new Map<string, string[]>();
  let pidCounter = 6000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.resume === true) resumeRequests.push(req);
    const sessionId = req.sessionId ?? randomUUID();
    const writes: string[] = [];
    writesBySession.set(sessionId, writes);
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    return {
      sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };

  function provisionSession(roleId: string): string {
    const agent = agents.create({ workspace_id: ws.id, role_id: roleId });
    const sessionId = randomUUID();
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleId,
      pid: 1,
    });
    return tokens.mint(sessionId);
  }

  const managerToken = provisionSession(managerRole.id);
  const workerToken = provisionSession(workerRole.id);

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

  return {
    server,
    db,
    workspaces,
    workspaceRoles,
    roles,
    agents,
    sessions,
    tokens,
    workspaceId: ws.id,
    managerToken,
    workerToken,
    workerRoleId: workerRole.id,
    resumeRequests,
    writesBySession,
    repoPath,
  };
}

// Create an ended, resumable worker session (agent survives end; provider
// thread id present so the runtime can be resumed).
function seedEndedWorkerSession(h: Harness): {
  sessionId: string;
  agentId: string;
} {
  const agent = h.agents.create({ workspace_id: h.workspaceId, role_id: h.workerRoleId });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: h.workspaceId,
    role_id: h.workerRoleId,
    provider_thread_id: sessionId,
    pid: 4242,
  });
  h.sessions.markEnded(sessionId);
  return { sessionId, agentId: agent.id };
}

let h: Harness;
beforeEach(() => {
  h = buildHarness();
});
afterEach(async () => {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
});

describe("POST /agent/sessions/:id/resume", () => {
  it("manager revives an ended session — clears ended_at, resumes the thread", async () => {
    const ended = seedEndedWorkerSession(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
      payload: { prompt: "CI is green, open the PR" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; pid: number };
    expect(body.session_id).toBe(ended.sessionId);
    expect(body.pid).toBeGreaterThan(0);

    const after = h.sessions.get(ended.sessionId)!;
    expect(after.ended_at).toBeUndefined();

    // Resumed against the existing provider thread, not a fresh spawn.
    expect(h.resumeRequests.length).toBe(1);
    expect(h.resumeRequests[0]!.providerThreadId).toBe(ended.sessionId);
  });

  it("a prompted resume forwards exactly the prompt to the runtime", async () => {
    const ended = seedEndedWorkerSession(h);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
      payload: { prompt: "ship it" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.resumeRequests.length).toBe(1);
    // The seeded workspace uses the noop boot-context provider, so the resume
    // prompt flows through unwrapped — exactly the injected user turn.
    expect(h.resumeRequests[0]!.prompt).toBe("ship it");
  });

  it("a bare resume composes no user message for the runtime", async () => {
    const ended = seedEndedWorkerSession(h);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(h.resumeRequests.length).toBe(1);
    // No prompt + noop boot context => nothing to inject. The `?? ""` default
    // that used to fabricate an empty user turn (#227) is gone.
    expect(h.resumeRequests[0]!.prompt).toBeUndefined();
  });

  it("a bare resume leaves the session idle and a follow-up prompt delivers immediately, in order (#366)", async () => {
    const ended = seedEndedWorkerSession(h);

    // The UI resume button: no prompt, kick suppressed, so no turn runs. Pre-fix
    // this registered busy:true forever (no Stop ever fires) and the #360 inject
    // queue stranded every composer message until some later real turn's Stop.
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(200);

    // Root fix (#366 part a): a suppressed-kick resume registers idle.
    const listed = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${h.workspaceId}`,
    });
    const summary = (listed.json() as { session_id: string; busy: boolean }[]).find(
      (s) => s.session_id === ended.sessionId,
    );
    expect(summary!.busy).toBe(false);

    // Two composer messages to the now-idle session: written straight to stdin,
    // immediately and in send order — not enqueued, not reordered (#366 strand gone).
    const first = await h.server.inject({
      method: "POST",
      url: `/sessions/${ended.sessionId}/prompt`,
      payload: { prompt: "We're back!" },
    });
    expect(first.statusCode).toBe(200);
    const second = await h.server.inject({
      method: "POST",
      url: `/sessions/${ended.sessionId}/prompt`,
      payload: { prompt: "Can you see this?" },
    });
    expect(second.statusCode).toBe(200);

    const written = h.writesBySession.get(ended.sessionId)!.join("");
    expect(written).toBe(
      serializeUserMessage("We're back!") + serializeUserMessage("Can you see this?"),
    );
  });

  it("a worker is denied (403) — workers don't bring sessions back", async () => {
    const ended = seedEndedWorkerSession(h);
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/'resume'/);
    expect(body.error).toMatch(/'worker'/);
  });

  it("returns 404 for an unknown session id", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${randomUUID()}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the target belongs to another workspace", async () => {
    const otherRepo = mkdtempSync(join(tmpdir(), "clobber-resume-other-"));
    const otherWs = h.workspaces.create({ name: `ws-${randomUUID()}`, repo_path: otherRepo });
    seedWorkspaceRoles(h.db, otherWs.id);
    const otherWorker = h.roles.findInWorkspace(otherWs.id, "worker")!;
    const agent = h.agents.create({ workspace_id: otherWs.id, role_id: otherWorker.id });
    const sessionId = randomUUID();
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: otherWs.id,
      role_id: otherWorker.id,
      provider_thread_id: sessionId,
      pid: 7,
    });
    h.sessions.markEnded(sessionId);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
    rmSync(otherRepo, { recursive: true, force: true });
  });

  it("repairs a poisoned on-disk transcript before re-sending history (#360)", async () => {
    const ended = seedEndedWorkerSession(h);
    // A bricked session: its transcript ends in an interrupted assistant turn
    // (unanswered tool_use) followed by a CLI synthetic-error placeholder.
    // Resuming over this debris is what 400s; repair must strip it first.
    const transcriptPath = join(h.repoPath, `${ended.sessionId}.jsonl`);
    const records = [
      { type: "user", message: { role: "user", content: "start the task" } },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          role: "assistant",
          content: [
            // The real persisted form: thinking text redacted, signature kept.
            { type: "thinking", thinking: "", signature: "sigOK==" },
            { type: "text", text: "On it." },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "EsUKpoison==" },
            { type: "tool_use", id: "toolu_9", name: "Bash", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: "API Error: 400" }],
        },
      },
    ];
    const rawLines = records.map((r) => JSON.stringify(r));
    writeFileSync(transcriptPath, rawLines.join("\n") + "\n");
    h.sessions.updateTranscriptPath(ended.sessionId, transcriptPath);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
      payload: { prompt: "continue" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.resumeRequests.length).toBe(1);

    // The poisoned partial turn + synthetic placeholder are gone; the transcript
    // now ends on the last clean assistant turn, so the re-sent history is valid.
    const after = readFileSync(transcriptPath, "utf8");
    const keptRaw = after.split("\n").filter((l) => l.length > 0);
    expect(keptRaw).toEqual(rawLines.slice(0, 2));
    expect(after).not.toContain("EsUKpoison");
    expect(after).not.toContain("<synthetic>");
  });

  it("returns 403 when reviving would exceed the role ceiling", async () => {
    h.workspaceRoles.setCeiling(h.workspaceId, h.workerRoleId, 1);
    // One active worker session occupies the only slot.
    const activeAgent = h.agents.create({
      workspace_id: h.workspaceId,
      role_id: h.workerRoleId,
    });
    h.sessions.create({
      id: randomUUID(),
      agent_id: activeAgent.id,
      workspace_id: h.workspaceId,
      role_id: h.workerRoleId,
      pid: 9,
    });
    const ended = seedEndedWorkerSession(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/sessions/${ended.sessionId}/resume`,
      headers: { authorization: `Bearer ${h.managerToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/capacity/);
    // Still ended — the failed resume did not re-occupy the slot.
    expect(h.sessions.get(ended.sessionId)!.ended_at).toBeDefined();
  });
});
