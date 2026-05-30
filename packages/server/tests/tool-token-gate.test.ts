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

// #321 — the tool-token primitive, exercised end-to-end through its first
// (minimal, internal) consumer: the `test-tool` route. An un-tokened call
// no-ops and injects the repercussion brief + one-time token into the TARGET's
// transcript; redemption with that token fires the action; re-running revokes;
// a failed action leaves the token live (retry-until-success).

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  agentStatuses: ReturnType<typeof createAgentStatusStore>;
  stdinChunks: Map<string, string>;
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
  const agentStatuses = createAgentStatusStore(db);
  // Per-session capture of everything written to the child's stdin, so a test
  // can assert that a tool-token interjection actually landed in the target's
  // transcript (the inject path writes the serialized turn to live stdin).
  const stdinChunks = new Map<string, string>();
  let pidCounter = 6000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const sessionId = req.sessionId;
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      stdinChunks.set(sessionId, (stdinChunks.get(sessionId) ?? "") + chunk.toString("utf8"));
    });
    return {
      sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin,
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
    agentStatuses,
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
    roles,
    workspaceRoles,
    sessions,
    tokens,
    agentStatuses,
    stdinChunks,
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-tool-token-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface Booted {
  workspaceId: string;
  callerSessionId: string;
  callerToken: string;
  roleId: string;
}

async function bootCaller(h: Harness): Promise<Booted> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.findByName("manager") ?? h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "caller" },
  });
  if (res.statusCode !== 200) throw new Error(`boot failed: ${res.body}`);
  const body = res.json() as { session_id: string };
  return {
    workspaceId: ws.id,
    callerSessionId: body.session_id,
    callerToken: h.tokens.mint(body.session_id),
    roleId: role.id,
  };
}

async function spawnTarget(
  h: Harness,
  callerToken: string,
): Promise<{ sessionId: string; token: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/agent/spawn",
    headers: { authorization: `Bearer ${callerToken}` },
    payload: { role: "manager", prompt: "work", label: "target" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn failed: ${res.body}`);
  const body = res.json() as { session_id: string };
  return { sessionId: body.session_id, token: h.tokens.mint(body.session_id) };
}

async function mint(
  h: Harness,
  callerToken: string,
  body: { target_session_id: string; effect: string; fail_attempts?: number },
): Promise<{ status: number; ack: string; raw: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/agent/test-tool",
    headers: { authorization: `Bearer ${callerToken}` },
    payload: body,
  });
  const json = res.json() as { ack?: string };
  return { status: res.statusCode, ack: json.ack ?? "", raw: res.body };
}

async function redeem(
  h: Harness,
  callerToken: string,
  token: string,
): Promise<{ status: number; raw: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/agent/test-tool",
    headers: { authorization: `Bearer ${callerToken}` },
    payload: { token },
  });
  return { status: res.statusCode, raw: res.body };
}

// Scan the captured stdin for the tool-token interjection and pull the token
// back out of the brief — the agent's real path is to read the token from its
// own transcript, so the test reads it the same way.
async function waitForInterjectedToken(
  h: Harness,
  sessionId: string,
): Promise<{ content: string; token: string }> {
  // #360: a brief injected into a busy (mid-turn) session is held back and
  // flushed on the next turn boundary, never written into an open thinking
  // block. Advance to that boundary so the deferred interjection lands.
  await fireStopToFlush(h, sessionId);
  for (let i = 0; i < 200; i++) {
    const buf = h.stdinChunks.get(sessionId);
    if (buf !== undefined) {
      for (const line of buf.split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as { message?: { content?: string } };
        const content = parsed.message?.content;
        if (content !== undefined && content.includes('type="tool-token"')) {
          const m = content.match(/--token (\S+)/);
          if (m === null) throw new Error("interjection missing a --token redemption line");
          return { content, token: m[1]! };
        }
      }
    }
    await Bun.sleep(5);
  }
  throw new Error(`no tool-token interjection landed in session ${sessionId}`);
}

// Fire the Stop hook (busy→idle) so any inject deferred mid-turn flushes to the
// live child's stdin — the production turn-boundary delivery path (#360).
async function fireStopToFlush(h: Harness, sessionId: string): Promise<void> {
  const transcriptPath = h.sessions.get(sessionId)?.transcript_path ?? "/tmp/t.jsonl";
  await h.server.inject({
    method: "POST",
    url: "/hook",
    payload: {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: "/r",
      permission_mode: "default",
      hook_event_name: "Stop",
    },
  });
}

describe("tool-token primitive (#321)", () => {
  it("un-tokened call no-ops, returns an ack-only, and injects brief+token into the TARGET transcript", async () => {
    const h = buildHarness();
    const boot = await bootCaller(h);
    const target = await spawnTarget(h, boot.callerToken);

    const res = await mint(h, boot.callerToken, {
      target_session_id: target.sessionId,
      effect: "alpha",
    });
    expect(res.status).toBe(200);
    // The CLI return is an acknowledgement only — the token never rides back
    // through the caller's return value.
    expect(res.ack.length).toBeGreaterThan(0);

    const { content, token } = await waitForInterjectedToken(h, target.sessionId);
    expect(content).toContain('type="tool-token"');
    expect(content).toContain('via="test-tool"');
    // The token is delivered into the bearer's transcript, NOT the caller's ack.
    expect(res.raw).not.toContain(token);

    // No-op: the action has not fired yet.
    expect(h.agentStatuses.get(target.sessionId)).toBeNull();
    await teardown(h);
  });

  it("redeeming with the token fires the action with the originally-saved args", async () => {
    const h = buildHarness();
    const boot = await bootCaller(h);
    const target = await spawnTarget(h, boot.callerToken);

    await mint(h, boot.callerToken, { target_session_id: target.sessionId, effect: "beta" });
    const { token } = await waitForInterjectedToken(h, target.sessionId);

    // The bearer redeems in its own frame, authenticated as itself.
    const r = await redeem(h, target.token, token);
    expect(r.status).toBe(200);

    const status = h.agentStatuses.get(target.sessionId);
    expect(status).not.toBeNull();
    // Saved args travel with the token: the effect minted earlier shows up.
    expect(status!.summary).toContain("beta");
    await teardown(h);
  });

  it("a wrong or absent token does not fire the action", async () => {
    const h = buildHarness();
    const boot = await bootCaller(h);
    const target = await spawnTarget(h, boot.callerToken);
    await mint(h, boot.callerToken, { target_session_id: target.sessionId, effect: "gamma" });
    await waitForInterjectedToken(h, target.sessionId);

    const wrong = await redeem(h, target.token, "not-a-real-token");
    expect(wrong.status).toBe(403);
    expect(h.agentStatuses.get(target.sessionId)).toBeNull();
    await teardown(h);
  });

  it("a non-bearer cannot redeem a token minted for another agent", async () => {
    const h = buildHarness();
    const boot = await bootCaller(h);
    const target = await spawnTarget(h, boot.callerToken);
    await mint(h, boot.callerToken, { target_session_id: target.sessionId, effect: "delta" });
    const { token } = await waitForInterjectedToken(h, target.sessionId);

    // The caller (manager) holds the token value but is not the bound bearer.
    const r = await redeem(h, boot.callerToken, token);
    expect(r.status).toBe(403);
    expect(h.agentStatuses.get(target.sessionId)).toBeNull();
    await teardown(h);
  });

  it("re-issuing the originating command revokes the prior token and mints a fresh one", async () => {
    const h = buildHarness();
    const boot = await bootCaller(h);
    const target = await spawnTarget(h, boot.callerToken);

    await mint(h, boot.callerToken, { target_session_id: target.sessionId, effect: "first" });
    const firstToken = (await waitForInterjectedToken(h, target.sessionId)).token;

    // Re-run with new args revokes the prior token.
    h.stdinChunks.delete(target.sessionId);
    await mint(h, boot.callerToken, { target_session_id: target.sessionId, effect: "second" });
    const secondToken = (await waitForInterjectedToken(h, target.sessionId)).token;
    expect(secondToken).not.toBe(firstToken);

    const stale = await redeem(h, target.token, firstToken);
    expect(stale.status).toBe(403);
    expect(h.agentStatuses.get(target.sessionId)).toBeNull();

    const fresh = await redeem(h, target.token, secondToken);
    expect(fresh.status).toBe(200);
    expect(h.agentStatuses.get(target.sessionId)!.summary).toContain("second");
    await teardown(h);
  });

  it("a failed action leaves the token live (retry-until-success)", async () => {
    const h = buildHarness();
    const boot = await bootCaller(h);
    const target = await spawnTarget(h, boot.callerToken);

    await mint(h, boot.callerToken, {
      target_session_id: target.sessionId,
      effect: "epsilon",
      fail_attempts: 1,
    });
    const { token } = await waitForInterjectedToken(h, target.sessionId);

    // First redemption fails inside the action; the token is NOT consumed.
    const first = await redeem(h, target.token, token);
    expect(first.status).toBe(500);
    expect(h.agentStatuses.get(target.sessionId)).toBeNull();

    // Same token, no re-running the interlock: now it succeeds.
    const second = await redeem(h, target.token, token);
    expect(second.status).toBe(200);
    expect(h.agentStatuses.get(target.sessionId)!.summary).toContain("epsilon");

    // And it is one-time: a third redemption of the consumed token is rejected.
    const third = await redeem(h, target.token, token);
    expect(third.status).toBe(403);
    await teardown(h);
  });

  it("self-target: the caller receives the interjection in its own transcript and redeems it", async () => {
    const h = buildHarness();
    const boot = await bootCaller(h);

    await mint(h, boot.callerToken, {
      target_session_id: boot.callerSessionId,
      effect: "selfie",
    });
    const { content, token } = await waitForInterjectedToken(h, boot.callerSessionId);
    expect(content).toContain('via="test-tool"');

    const r = await redeem(h, boot.callerToken, token);
    expect(r.status).toBe(200);
    expect(h.agentStatuses.get(boot.callerSessionId)!.summary).toContain("selfie");
    await teardown(h);
  });
});
