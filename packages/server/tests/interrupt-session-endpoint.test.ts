import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";

interface KillRecord {
  readonly sessionId: string;
  readonly signal: NodeJS.Signals;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  sessions: ReturnType<typeof createSessionStore>;
  killCalls: KillRecord[];
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
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const sessionId = req.sessionId;
    const stdin = new PassThrough();
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
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
  });
  return { server, db, sessions, killCalls, repoPath };
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

  it("SIGINT-s the live child while a turn is in flight and clears busy", async () => {
    const h = buildHarness();
    const spawned = await spawn(h);

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawned.session_id}/interrupt`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ ok: true });
    expect(h.killCalls).toEqual([
      { sessionId: spawned.session_id, signal: "SIGINT" },
    ]);

    // After interrupt the agent must be considered idle, so a follow-up
    // prompt should write to stdin (200) instead of returning 409.
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
    expect(parsed.message.content).toContain("[SYSTEM NOTIFICATION");
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
    expect(h.killCalls).toEqual([
      { sessionId: spawned.session_id, signal: "SIGINT" },
    ]);
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
