import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore, type EventStore } from "../src/event-store.ts";
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
import { createLayoutEventStore } from "../src/layout-event-store.ts";
import type { AgentSpawner, SpawnedAgentInfo, AgentSpawnRequest } from "../src/types.ts";
import type { CycleBootFailedPayload, Session } from "@clobber/shared";

// #320 — `clobber cycle`, the kill-first capstone over the three shipped
// primitives (token gate #321, layout bus #326, agent-target #323). Exercised
// end-to-end through `POST /agent/cycle`: an un-tokened call no-ops and injects
// the brief+token into the TARGET's transcript; redemption kills the old
// session FIRST (so a ceiling-1 role passes its respawn capacity check), spawns
// a fresh session on the SAME agent under the op-level orientation + chosen
// wake-program, emits a `swap_session_tab` layout event, and consumes the token
// only on success.

interface SpawnRecord {
  readonly sessionId: string;
  readonly prompt: string | undefined;
  readonly promptTag: AgentSpawnRequest["promptTag"];
  readonly systemPrompt: string | undefined;
  readonly cwd: string;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  layoutEvents: ReturnType<typeof createLayoutEventStore>;
  events: EventStore;
  stdinChunks: Map<string, string>;
  spawns: Map<string, SpawnRecord>;
  control: { failNextSpawns: number; failKillForSessions: Set<string> };
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
  const layoutEvents = createLayoutEventStore();
  const events = createEventStore(db);
  const stdinChunks = new Map<string, string>();
  const spawns = new Map<string, SpawnRecord>();
  const control = { failNextSpawns: 0, failKillForSessions: new Set<string>() };
  let pidCounter = 7000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    // A boot failure: the only failure mode cycle's minimal in-handler retry
    // senses (a synchronous spawn throw). The test toggles this between mint and
    // redeem to drive the bounded-backoff respawn loop.
    if (control.failNextSpawns > 0) {
      control.failNextSpawns -= 1;
      throw new Error("simulated boot failure");
    }
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const sessionId = req.sessionId;
    spawns.set(sessionId, {
      sessionId,
      prompt: req.prompt,
      promptTag: req.promptTag,
      systemPrompt: req.appendSystemPrompt,
      cwd: req.cwd,
    });
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      stdinChunks.set(sessionId, (stdinChunks.get(sessionId) ?? "") + chunk.toString("utf8"));
    });
    return {
      sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {
        if (control.failKillForSessions.has(sessionId)) {
          throw new Error("simulated kill failure");
        }
      },
    };
  };
  const server = createServer({
    db,
    store: events,
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
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    layoutEvents,
    sleep: () => Promise.resolve(),
  });
  return {
    server,
    db,
    workspaces,
    roles,
    workspaceRoles,
    sessions,
    tokens,
    layoutEvents,
    events,
    stdinChunks,
    spawns,
    control,
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-cycle-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface Booted {
  workspaceId: string;
  callerSessionId: string;
  callerToken: string;
  agentId: string;
  roleId: string;
}

async function bootManager(h: Harness, ceiling: number): Promise<Booted> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.findByName("manager") ?? h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, role.id, ceiling);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boss" },
  });
  if (res.statusCode !== 200) throw new Error(`boot failed: ${res.body}`);
  const body = res.json() as { agent_id: string; session_id: string };
  return {
    workspaceId: ws.id,
    callerSessionId: body.session_id,
    callerToken: h.tokens.mint(body.session_id),
    agentId: body.agent_id,
    roleId: role.id,
  };
}

async function cycle(
  h: Harness,
  bearerToken: string,
  body: { target_session_id?: string; prompt?: string; token?: string },
): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/agent/cycle",
    headers: { authorization: `Bearer ${bearerToken}` },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown>, raw: res.body };
}

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
          if (m === null) throw new Error("interjection missing a --token line");
          return { content, token: m[1]! };
        }
      }
    }
    await Bun.sleep(5);
  }
  throw new Error(`no cycle interjection landed in session ${sessionId}`);
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

function activeForAgent(h: Harness, wsId: string, agentId: string): Session[] {
  return h.sessions
    .listForWorkspace(wsId)
    .filter((s) => s.agent_id === agentId && s.ended_at === undefined);
}

function tokenRows(h: Harness, token: string): number {
  const row = h.db
    .prepare("SELECT count(*) AS n FROM tool_tokens WHERE token = ?")
    .get(token) as { n: number };
  return row.n;
}

describe("clobber cycle (#320)", () => {
  it("un-tokened self-cycle no-ops and injects the brief+token into the caller's own transcript", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);

    const res = await cycle(h, boot.callerToken, { prompt: "carry on: finish the audit" });
    expect(res.status).toBe(200);
    expect(typeof res.json["ack"]).toBe("string");

    const { content, token } = await waitForInterjectedToken(h, boot.callerSessionId);
    expect(content).toContain('via="cycle"');
    // The token never rides back through the caller's return value.
    expect(res.raw).not.toContain(token);
    // No-op: the old session is still live, nothing cycled.
    expect(activeForAgent(h, boot.workspaceId, boot.agentId)).toHaveLength(1);
    expect(activeForAgent(h, boot.workspaceId, boot.agentId)[0]!.id).toBe(boot.callerSessionId);
    await teardown(h);
  });

  it("redeem at ceiling-1 kills first, respawns on the SAME agent with op-level orientation + custom wake-program, swaps the tab, consumes the token", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);
    expect(h.sessions.countActive(boot.workspaceId, boot.roleId)).toBe(1);

    await cycle(h, boot.callerToken, { prompt: "HANDOFF: state is in office notes; resume the audit" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);

    const r = await cycle(h, boot.callerToken, { token });
    expect(r.status).toBe(200);

    // Old session ended; exactly one fresh active session on the SAME agent row.
    const old = h.sessions.get(boot.callerSessionId)!;
    expect(old.ended_at).not.toBeUndefined();
    const active = activeForAgent(h, boot.workspaceId, boot.agentId);
    expect(active).toHaveLength(1);
    const fresh = active[0]!;
    expect(fresh.id).not.toBe(boot.callerSessionId);
    expect(fresh.agent_id).toBe(boot.agentId);
    // wake_program is the chosen program (custom by default), NOT "cycle".
    expect(fresh.wake_program).toBe("custom");
    // The op-level orientation (the "freshly-cycled" structural text) is persisted
    // separately so resume can re-compose it.
    expect(fresh.op_level_addon).toBeDefined();
    expect(fresh.op_level_addon).toContain("freshly-cycled");
    // Ceiling-1 held throughout: back to exactly one active session.
    expect(h.sessions.countActive(boot.workspaceId, boot.roleId)).toBe(1);

    // The fresh session booted under the cycle layer-C system + the caller's
    // --prompt as the (wake-kick-tagged) opening turn.
    const spawned = h.spawns.get(fresh.id)!;
    expect(spawned.systemPrompt).toContain("freshly-cycled");
    expect(spawned.prompt).toBe("HANDOFF: state is in office notes; resume the audit");
    expect(spawned.promptTag).toEqual({ kind: "wake-kick" });
    // Same worktree/checkout retained across the kill.
    expect(spawned.cwd).toBe(h.spawns.get(boot.callerSessionId)!.cwd);

    // The tab-swap rode the layout bus (old → new), for clients to apply on poll.
    const events = h.layoutEvents.since(boot.workspaceId, 0);
    const swap = events.find((e) => e.event.action.type === "swap_session_tab");
    expect(swap).not.toBeUndefined();
    expect(swap!.event.action).toMatchObject({
      type: "swap_session_tab",
      oldSessionId: boot.callerSessionId,
      newSessionId: fresh.id,
    });

    // Token consumed exactly once on success.
    expect(tokenRows(h, token)).toBe(0);
    await teardown(h);
  });

  it("retries the respawn with bounded backoff on boot failure, then consumes the token on success", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);
    await cycle(h, boot.callerToken, { prompt: "handoff" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);

    // The first two respawn attempts fail to boot; the in-handler retry recovers.
    h.control.failNextSpawns = 2;
    const r = await cycle(h, boot.callerToken, { token });
    expect(r.status).toBe(200);

    const active = activeForAgent(h, boot.workspaceId, boot.agentId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(boot.callerSessionId);
    expect(tokenRows(h, token)).toBe(0);
    await teardown(h);
  });

  it("spawn-first: exhausted retries leave the old session alive — token preserved, never zero sessions", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);
    await cycle(h, boot.callerToken, { prompt: "handoff" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);

    // Exhaust every retry: action throws, token stays live as durable record.
    h.control.failNextSpawns = 50;
    const failed = await cycle(h, boot.callerToken, { token });
    expect(failed.status).toBe(500);
    expect(tokenRows(h, token)).toBe(1);

    // Spawn-first: old session was NEVER touched → agent keeps exactly one live session.
    expect(h.sessions.get(boot.callerSessionId)!.ended_at).toBeUndefined();
    expect(activeForAgent(h, boot.workspaceId, boot.agentId)).toHaveLength(1);
    await teardown(h);
  });

  it("cycle.boot_failed event: each failed respawn attempt writes a durable event with non-empty stack", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);
    await cycle(h, boot.callerToken, { prompt: "handoff" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);

    // Two attempts fail, third succeeds — expect exactly two failure events.
    h.control.failNextSpawns = 2;
    await cycle(h, boot.callerToken, { token });

    const failEvents = h.events
      .list()
      .filter((e) => e.payload.hook_event_name === "cycle.boot_failed");
    expect(failEvents).toHaveLength(2);

    for (const e of failEvents) {
      const p = e.payload as CycleBootFailedPayload;
      expect(p.kill_session_id).toBe(boot.callerSessionId);
      expect(p.agent_id).toBe(boot.agentId);
      expect(typeof p.error_stack).toBe("string");
      expect((p.error_stack as string).length).toBeGreaterThan(0);
      expect(p.attempt).toBeGreaterThanOrEqual(0);
    }
    await teardown(h);
  });

  it("supervisor: old-kill failure after spawn-first → supervisor force-ends old, cycle returns 200, exactly one session", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);
    await cycle(h, boot.callerToken, { prompt: "handoff" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);

    // Arm a kill failure for the old session: spawn succeeds, SIGTERM throws.
    h.control.failKillForSessions.add(boot.callerSessionId);
    const r = await cycle(h, boot.callerToken, { token });
    // Supervisor recovered the invariant — cycle is functionally complete.
    expect(r.status).toBe(200);

    // Supervisor guaranteed exactly one active session (the fresh one).
    const active = activeForAgent(h, boot.workspaceId, boot.agentId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(boot.callerSessionId);
    // Old session was force-ended by supervisor.
    expect(h.sessions.get(boot.callerSessionId)!.ended_at).not.toBeUndefined();
    await teardown(h);
  });

  it("cross-agent: the brief lands in the TARGET's transcript and the target redeems to cycle itself", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 5);
    // A second persistent agent (the cycle target).
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.callerToken}` },
      payload: { role: "manager", prompt: "work", label: "deputy" },
    });
    const targetBody = spawnRes.json() as { agent_id: string; session_id: string };
    const targetToken = h.tokens.mint(targetBody.session_id);

    // The manager mints against the target — no force-interrupt, just a request.
    const minted = await cycle(h, boot.callerToken, {
      target_session_id: targetBody.session_id,
      prompt: "wrap and cycle yourself",
    });
    expect(minted.status).toBe(200);
    const { token } = await waitForInterjectedToken(h, targetBody.session_id);

    // The target reads the brief in its own frame and redeems as itself.
    const r = await cycle(h, targetToken, { token });
    expect(r.status).toBe(200);
    const active = activeForAgent(h, boot.workspaceId, targetBody.agent_id);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(targetBody.session_id);
    expect(active[0]!.wake_program).toBe("custom");
    await teardown(h);
  });

  it("rejects cycling a non-persistent (ephemeral) target — v1 is persistent-only", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 5);
    const workerRole =
      h.roles.findByName("worker") ?? h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(boot.workspaceId, workerRole.id, 3);
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${boot.callerToken}` },
      payload: { role: "worker", prompt: "work", label: "hand" },
    });
    if (spawnRes.statusCode !== 200) throw new Error(`worker spawn failed: ${spawnRes.body}`);
    const worker = spawnRes.json() as { session_id: string };

    const res = await cycle(h, boot.callerToken, {
      target_session_id: worker.session_id,
      prompt: "cycle the worker",
    });
    expect(res.status).toBe(422);
    await teardown(h);
  });
});
