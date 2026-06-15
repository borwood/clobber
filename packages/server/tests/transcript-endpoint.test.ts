import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { stubSpawnedAgent } from "./_spawner-stub.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tmp: string;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const tmp = mkdtempSync(join(tmpdir(), "clobber-transcript-"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,

    roleVersions,
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent(),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, agents, sessions, tmp };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
  rmSync(h.tmp, { recursive: true, force: true });
}

interface Seeded {
  readonly sessionId: string;
}

function seedSession(h: Harness): Seeded {
  const ws = h.workspaces.create({ name: `ws-${randomUUID()}`, repo_path: "/r" });
  const role = h.roles.create({ name: `role-${randomUUID()}`, persistent: false });
  const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    pid: 9000,
  });
  return { sessionId };
}

interface TranscriptResponse {
  lines: Array<Record<string, unknown>>;
  cursor: number;
}

function asResponse(json: unknown): TranscriptResponse {
  return json as TranscriptResponse;
}

describe("GET /sessions/:id/transcript — ?since cursor (incremental fetch)", () => {
  it("cold fetch returns { lines, cursor } shape with cursor = JSONL line count", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "a" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "b" } }),
        "",
      ].join("\n"),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    expect(body.lines).toHaveLength(3);
    expect(body.cursor).toBe(3);
    await teardown(h);
  });

  it("cold fetch returns cursor=0 when no transcript file", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    expect(body.lines).toEqual([]);
    expect(body.cursor).toBe(0);
    await teardown(h);
  });

  it("?since=N returns lines from offset N onward (inclusive), no prefix, cursor = total JSONL", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "first" } }),  // offset 0
        JSON.stringify({ type: "user", message: { role: "user", content: "second" } }), // offset 1
        JSON.stringify({ type: "user", message: { role: "user", content: "third" } }),  // offset 2
        "",
      ].join("\n"),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript?since=2`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    // since=2 → lines from offset 2 onward → only "third"
    expect(body.lines).toHaveLength(1);
    expect((body.lines[0]! as { message: { content: string } }).message.content).toBe("third");
    expect(body.cursor).toBe(3);
    await teardown(h);
  });

  it("?since=cursor returns empty lines when nothing new, cursor unchanged", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [JSON.stringify({ type: "user", message: { role: "user", content: "msg" } }), ""].join("\n"),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript?since=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    expect(body.lines).toEqual([]);
    expect(body.cursor).toBe(1);
    await teardown(h);
  });

  it("append flow: cold fetch then incremental grows array by exactly new lines", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    const lineA = JSON.stringify({ type: "user", message: { role: "user", content: "A" } });
    const lineB = JSON.stringify({ type: "user", message: { role: "user", content: "B" } });
    const lineC = JSON.stringify({ type: "user", message: { role: "user", content: "C" } });
    writeFileSync(path, [lineA, lineB, ""].join("\n"));
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    // Cold fetch — gets A and B
    const cold = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    const coldBody = asResponse(cold.json());
    expect(coldBody.lines).toHaveLength(2);
    const cursor = coldBody.cursor;
    expect(cursor).toBe(2);

    // Append a new line to the file
    writeFileSync(path, [lineA, lineB, lineC, ""].join("\n"));

    // Incremental fetch — gets only C
    const inc = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript?since=${cursor}`,
    });
    const incBody = asResponse(inc.json());
    expect(incBody.lines).toHaveLength(1);
    expect((incBody.lines[0]! as { message: { content: string } }).message.content).toBe("C");
    expect(incBody.cursor).toBe(3);
    await teardown(h);
  });

  it("incremental fetch does not include the system-prompt prefix", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    h.sessions.updateComposedSystemPrompt(seed.sessionId, "You are a test agent.");
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [JSON.stringify({ type: "user", message: { role: "user", content: "msg" } }), ""].join(
        "\n",
      ),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    // Cold fetch includes prefix
    const cold = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    const coldBody = asResponse(cold.json());
    expect(coldBody.lines[0]!["type"]).toBe("system-prompt");
    expect(coldBody.cursor).toBe(1); // prefix not counted

    // Incremental fetch does NOT include prefix
    const inc = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript?since=0`,
    });
    const incBody = asResponse(inc.json());
    expect(incBody.lines[0]!["type"]).not.toBe("system-prompt");
    expect(incBody.lines[0]!["type"]).toBe("user");
    await teardown(h);
  });
});

describe("GET /sessions/:id/transcript — cold fetch", () => {
  it("404 when the session does not exist", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${randomUUID()}/transcript`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("session not found");
    await teardown(h);
  });

  it("returns empty lines + cursor=0 when the session has no transcript_path", async () => {
    const h = buildHarness();
    const seed = seedSession(h);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    expect(body.lines).toEqual([]);
    expect(body.cursor).toBe(0);
    await teardown(h);
  });

  it("returns empty lines when transcript_path is set but the file does not exist", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    h.sessions.updateTranscriptPath(seed.sessionId, join(h.tmp, "missing.jsonl"));

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    expect(body.lines).toEqual([]);
    expect(body.cursor).toBe(0);
    await teardown(h);
  });

  it("returns parsed JSONL lines preserving file order", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({ type: "user", message: { role: "user", content: "next" } }),
        "",
      ].join("\n"),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    expect(body.lines).toHaveLength(3);
    expect(body.lines[0]!["type"]).toBe("permission-mode");
    expect(body.lines[1]!["type"]).toBe("assistant");
    expect(body.lines[2]!["type"]).toBe("user");
    expect(body.cursor).toBe(3);
    await teardown(h);
  });

  it("skips lines that fail to parse rather than erroring", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }),
        "this-is-not-json{{",
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
      ].join("\n"),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const body = asResponse(res.json());
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]!["type"]).toBe("user");
    expect(body.lines[1]!["type"]).toBe("assistant");
    await teardown(h);
  });
});
