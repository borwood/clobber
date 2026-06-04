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
import { createLayoutEventStore } from "../src/layout-event-store.ts";
import type { AgentSpawner, SpawnedAgentInfo, AgentSpawnRequest } from "../src/types.ts";
import type { Session } from "@clobber/shared";

// #502 — cycle op-level orientation: the cycle OPERATION injects a structural
// orientation layer independently of the chosen wake-program, so agents can be
// cycled with any opening move while still receiving the "freshly-cycled" brief.
// This test file covers the orientation semantics; kill-first + token flow are
// covered by agent-cycle-endpoint.test.ts.
//
// Harness uses the default claudeRuntimeProvider (session lifetime,
// livePromptInjection: true) so cycle inject writes directly to stdin. Resume
// is triggered via /sessions/:id/resume (the revive-ended path), after marking
// the session ended by simulating a process exit.

interface SpawnRecord {
  readonly sessionId: string;
  readonly prompt: string | undefined;
  readonly promptTag: AgentSpawnRequest["promptTag"];
  readonly systemPrompt: string | undefined;
  resolveExit: (code: number | null) => void;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  roleVersions: ReturnType<typeof createRoleVersionStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  layoutEvents: ReturnType<typeof createLayoutEventStore>;
  stdinChunks: Map<string, string>;
  records: SpawnRecord[];
}

function buildHarness(): Harness {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-cycle-orient-"));
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
  const stdinChunks = new Map<string, string>();
  const records: SpawnRecord[] = [];
  let pidCounter = 8000;
  // No runtimeProvider → defaults to claudeRuntimeProvider (session lifetime,
  // livePromptInjection: true), so cycle inject writes straight to stdin.
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const sessionId = req.sessionId;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((res) => { resolveExit = res; });
    records.push({
      sessionId,
      prompt: req.prompt,
      promptTag: req.promptTag,
      systemPrompt: req.appendSystemPrompt,
      resolveExit,
    });
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      stdinChunks.set(sessionId, (stdinChunks.get(sessionId) ?? "") + chunk.toString("utf8"));
    });
    return {
      sessionId,
      pid: pidCounter,
      exited,
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
    layoutEvents,
  });
  return {
    server,
    db,
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    sessions,
    tokens,
    layoutEvents,
    stdinChunks,
    records,
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-cycle-orient-repo-"));
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
  body: { target_session_id?: string; prompt?: string; token?: string; wake_program?: string },
): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/agent/cycle",
    headers: { authorization: `Bearer ${bearerToken}` },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown>, raw: res.body };
}

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

async function waitForInterjectedToken(
  h: Harness,
  sessionId: string,
): Promise<{ content: string; token: string }> {
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

function activeForAgent(h: Harness, wsId: string, agentId: string): Session[] {
  return h.sessions
    .listForWorkspace(wsId)
    .filter((s) => s.agent_id === agentId && s.ended_at === undefined);
}

// With claudeRuntimeProvider (session lifetime), endOnCleanExit=true so a clean
// exit marks the session row as ended — prerequisite for resume via
// /sessions/:id/resume (the revive-ended path).
async function exitSession(h: Harness, sessionId: string): Promise<void> {
  const rec = h.records.find((r) => r.sessionId === sessionId);
  if (rec !== undefined) rec.resolveExit(0);
  // Give the async exit handler a tick to mark the session ended.
  await new Promise<void>((r) => setTimeout(r, 20));
}

describe("cycle op-level orientation (#502)", () => {
  it("cycle injects op-level orientation into system prompt (separate from wake-program)", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);

    await cycle(h, boot.callerToken, { prompt: "HANDOFF: auditing done, notes in office" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);
    const r = await cycle(h, boot.callerToken, { token });
    expect(r.status).toBe(200);

    const active = activeForAgent(h, boot.workspaceId, boot.agentId);
    expect(active).toHaveLength(1);
    const fresh = active[0]!;

    // The op-level orientation is persisted on the session row.
    expect(fresh.op_level_addon).toBeDefined();
    expect(fresh.op_level_addon).toContain("freshly-cycled");

    // The wake_program is the user-choosable program (default "custom"), NOT "cycle".
    expect(fresh.wake_program).toBe("custom");

    // The orientation text appears in the composed system prompt.
    const spawnRecord = h.records.find((r) => r.sessionId === fresh.id)!;
    expect(spawnRecord.systemPrompt).toContain("freshly-cycled");

    await teardown(h);
  });

  it("cycle wake_program=idle uses that program while orientation is still present", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);

    // Specify a built-in wake_program explicitly — orientation must still be injected.
    await cycle(h, boot.callerToken, { prompt: "HANDOFF: boot and wait", wake_program: "idle" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);
    const r = await cycle(h, boot.callerToken, { token });
    expect(r.status).toBe(200);

    const active = activeForAgent(h, boot.workspaceId, boot.agentId);
    expect(active).toHaveLength(1);
    const fresh = active[0]!;

    // Orientation is always present regardless of wake-program.
    expect(fresh.op_level_addon).toContain("freshly-cycled");
    // The wake_program reflects the caller's choice.
    expect(fresh.wake_program).toBe("idle");
    // System prompt contains orientation.
    const spawnRecord = h.records.find((r) => r.sessionId === fresh.id)!;
    expect(spawnRecord.systemPrompt).toContain("freshly-cycled");

    await teardown(h);
  });

  it("resume of a cycled session re-composes the op-level orientation layer", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, 1);

    // Cycle the manager.
    await cycle(h, boot.callerToken, { prompt: "HANDOFF: carry on" });
    const { token } = await waitForInterjectedToken(h, boot.callerSessionId);
    const r = await cycle(h, boot.callerToken, { token });
    expect(r.status).toBe(200);

    const active = activeForAgent(h, boot.workspaceId, boot.agentId);
    const fresh = active[0]!;
    const freshToken = h.tokens.mint(fresh.id);

    // End the fresh session (simulate process exit → marks session ended).
    await exitSession(h, fresh.id);
    expect(h.sessions.get(fresh.id)!.ended_at).not.toBeUndefined();

    // Resume the ended session via the revive-ended route.
    const resumeRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${fresh.id}/resume`,
      payload: { prompt: "wake again" },
    });
    expect(resumeRes.statusCode).toBe(200);

    // The resumed spawn's system prompt must still contain orientation.
    const resumedRecord = h.records[h.records.length - 1]!;
    expect(resumedRecord.systemPrompt).toContain("freshly-cycled");

    // The session row still carries op_level_addon.
    const resumedSession = h.sessions.get(fresh.id)!;
    expect(resumedSession.op_level_addon).toContain("freshly-cycled");

    // freshToken used to authenticate the resume call if needed.
    void freshToken;

    await teardown(h);
  });

  it("spawn (non-cycle) has no op-level orientation layer", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-spawn", repo_path: repoPath });
    const role = h.roles.findByName("manager") ?? h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "m1" },
    });
    expect(res.statusCode).toBe(200);
    const { session_id } = res.json() as { session_id: string };
    const session = h.sessions.get(session_id)!;

    // A plain spawn carries no op-level addon.
    expect(session.op_level_addon).toBeUndefined();
    // System prompt does not contain the cycle orientation text.
    const spawnRecord = h.records.find((r) => r.sessionId === session_id)!;
    expect(spawnRecord.systemPrompt).not.toContain("freshly-cycled");

    await teardown(h);
  });
});
