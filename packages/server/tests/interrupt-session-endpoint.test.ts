import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { claudeRuntimeProvider } from "@clobber/runtime";
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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";

interface KillRecord {
  readonly sessionId: string;
  readonly signal: NodeJS.Signals;
}

interface StdinWrite {
  readonly sessionId: string;
  readonly data: string;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  sessions: ReturnType<typeof createSessionStore>;
  killCalls: KillRecord[];
  stdinWrites: StdinWrite[];
  repoPath: string;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-interrupt-"));
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: "manager", persistent: false });
  workspaceRoles.setCeiling(ws.id, role.id, 1);
  const killCalls: KillRecord[] = [];
  const stdinWrites: StdinWrite[] = [];
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const sessionId = req.sessionId;
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) =>
      stdinWrites.push({ sessionId, data: chunk.toString() }),
    );
    stdin.resume();
    return {
      sessionId,
      pid: 9000,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: (signal) => killCalls.push({ sessionId, signal }),
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
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    runtimeProvider: {
      ...claudeRuntimeProvider,
      transcriptPath: (_cwd, sessionId) =>
        join(repoPath, "transcripts", `${sessionId}.jsonl`),
    },
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, sessions, killCalls, stdinWrites, repoPath };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

async function spawn(h: Harness): Promise<{ session_id: string; agent_id: string }> {
  const wsId = h.db.query<{ id: string }, []>("SELECT id FROM workspaces").all()[0]!.id;
  const roleId = h.db.query<{ id: string }, []>("SELECT id FROM roles").all()[0]!.id;
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: roleId, prompt: "go", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { session_id: string; agent_id: string };
}

async function fireStop(h: Harness, sessionId: string) {
  const res = await h.server.inject({
    method: "POST",
    url: "/hook",
    payload: {
      session_id: sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/r",
      permission_mode: "default" as const,
      hook_event_name: "Stop" as const,
    },
  });
  expect(res.statusCode).toBe(200);
}

describe("POST /sessions/:id/interrupt", () => {
  it("404 when the session does not exist", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${randomUUID()}/interrupt`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("session not found");
    await teardown(h);
  });

  it("410 when the session has already ended", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);
    h.sessions.markEnded(spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/interrupt`,
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe("session ended");
    await teardown(h);
  });

  it("409 when the agent is idle (no turn in flight)", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);
    await fireStop(h, spawned.session_id);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/interrupt`,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("agent idle");
    expect(h.killCalls).toEqual([]);
    await teardown(h);
  });

  it("writes a stream-json control_request interrupt to stdin and clears busy (does NOT kill)", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/interrupt`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ ok: true });

    // No signal sent — SIGINT would terminate `claude -p`, ending the session.
    expect(h.killCalls).toEqual([]);

    // One control_request line written to stdin.
    const interruptWrites = h.stdinWrites.filter(
      (w) => w.sessionId === spawned.session_id && w.data.includes('"control_request"'),
    );
    expect(interruptWrites).toHaveLength(1);
    const parsed = JSON.parse(interruptWrites[0]!.data.trim()) as {
      type: string;
      request_id: string;
      request: { subtype: string };
    };
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("interrupt");
    expect(typeof parsed.request_id).toBe("string");
    expect(parsed.request_id.length).toBeGreaterThan(0);

    // Busy cleared — a follow-up prompt should land (claude is still alive).
    const promptRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/prompt`,
      payload: { prompt: "follow-up" },
    });
    expect(promptRes.statusCode).toBe(200);

    await teardown(h);
  });

  it("appends an 'interrupted by user' notification line to the transcript", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);
    const transcriptPath = join(h.repoPath, "transcript.jsonl");
    writeFileSync(transcriptPath, "");
    h.sessions.updateTranscriptPath(spawned.session_id, transcriptPath);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/interrupt`,
    });
    expect(res.statusCode).toBe(200);

    const text = readFileSync(transcriptPath, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      type: string;
      message: { role: string; content: string };
    };
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    // The legacy `[SYSTEM NOTIFICATION - NOT USER INPUT]` string-header was
    // subsumed by the structured `<clobber type="interrupt-notice">` wrapper
    // in #261 — same provenance, now parsed structurally by the web classifier.
    expect(parsed.message.content).toContain(`<clobber type="interrupt-notice">`);
    expect(parsed.message.content).toContain("<status>interrupted</status>");
    expect(parsed.message.content).toContain("Interrupted by user");

    await teardown(h);
  });

  it("succeeds when the transcript file does not yet exist on disk", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/interrupt`,
    });
    expect(res.statusCode).toBe(200);
    expect(h.killCalls).toEqual([]);
    await teardown(h);
  });

  it("GET /sessions exposes busy=true mid-turn and busy=false after Stop", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);
    const wsId = h.db.query<{ id: string }, []>("SELECT id FROM workspaces").all()[0]!.id;

    const beforeStop = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${wsId}`,
    });
    expect(beforeStop.statusCode).toBe(200);
    const beforeRow = (beforeStop.json() as { session_id: string; busy: boolean }[]).find(
      (s) => s.session_id === spawned.session_id,
    );
    expect(beforeRow!.busy).toBe(true);

    await fireStop(h, spawned.session_id);

    const afterStop = await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${wsId}`,
    });
    const afterRow = (afterStop.json() as { session_id: string; busy: boolean }[]).find(
      (s) => s.session_id === spawned.session_id,
    );
    expect(afterRow!.busy).toBe(false);

    await teardown(h);
  });

  it("409 when the agent has no live registry entry (process already gone)", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);

    // First interrupt clears registry-busy. Now simulate the child having died
    // by ending the session manually then re-creating it without a registry
    // entry — easier path: end via /sessions/:id/end which kills + unregisters.
    // Then mark un-ended at the row level so we can hit the "no live" branch.
    await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/end`,
    });
    // Forge an un-ended row: use raw SQL to clear ended_at.
    h.db
      .prepare(`UPDATE sessions SET ended_at = NULL WHERE id = ?`)
      .run(spawned.session_id);
    expect(h.sessions.get(spawned.session_id)!.ended_at).toBeUndefined();

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/interrupt`,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("agent not running");
    await teardown(h);
  });
});
