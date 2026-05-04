import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  tmp: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const tmp = mkdtempSync(join(tmpdir(), "clobber-agent-transcript-"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  let pidCounter = 5000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };
  const server = createServer({
    store: createEventStore(db),
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens, tmp };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.tmp, { recursive: true, force: true });
}

let repoPath: string;
let otherRepoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-transcript-repo-"));
  otherRepoPath = mkdtempSync(join(tmpdir(), "clobber-agent-transcript-other-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(otherRepoPath, { recursive: true, force: true });
});

interface Booted {
  workspaceId: string;
  managerSessionId: string;
  managerToken: string;
}

async function bootManager(h: Harness, repo: string): Promise<Booted> {
  const ws = h.workspaces.create({ name: `ws-${repo}`, repo_path: repo });
  const role = h.roles.findByName("manager") ??
    h.roles.create({ name: "manager", persistent: true });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`boot failed: ${res.body}`);
  const body = res.json() as { session_id: string };
  return {
    workspaceId: ws.id,
    managerSessionId: body.session_id,
    managerToken: h.tokens.mint(body.session_id),
  };
}

function writeTranscript(h: Harness, sessionId: string, lines: object[]): string {
  const path = join(h.tmp, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  h.sessions.updateTranscriptPath(sessionId, path);
  return path;
}

const SAMPLE_TRANSCRIPT: object[] = [
  // 0 — meta event
  { type: "permission-mode", permissionMode: "default" },
  // 1 — user message
  { type: "user", message: { role: "user", content: "first ask" } },
  // 2 — assistant text
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
  },
  // 3 — assistant tool_use
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la" } }],
    },
  },
  // 4 — user tool_result
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2\nfile3\n" },
      ],
    },
  },
  // 5 — assistant text (final)
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  },
];

interface TranscriptResponse {
  total: number;
  selection: { kind: string; [key: string]: unknown };
  entries: ReadonlyArray<TranscriptEntry>;
}
interface TranscriptEntry {
  id: string;
  type: string;
  role?: "user" | "assistant";
  content?: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

async function fetchTranscript(
  h: Harness,
  sessionId: string,
  token: string,
  query: string = "",
): Promise<{ statusCode: number; body: TranscriptResponse | { error: string } }> {
  const url = `/agent/sessions/${sessionId}/transcript${query.length === 0 ? "" : `?${query}`}`;
  const res = await h.server.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  return { statusCode: res.statusCode, body: res.json() as TranscriptResponse | { error: string } };
}

describe("GET /agent/sessions/:id/transcript — auth + scope", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/sessions/abc/transcript",
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 401 for a revoked token", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    h.tokens.revoke(boot.managerSessionId);
    const r = await fetchTranscript(h, boot.managerSessionId, boot.managerToken);
    expect(r.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 404 for a missing session", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    const r = await fetchTranscript(h, "does-not-exist", boot.managerToken);
    expect(r.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 404 when target session is in another workspace", async () => {
    const h = buildHarness();
    const a = await bootManager(h, repoPath);
    const b = await bootManager(h, otherRepoPath);
    const r = await fetchTranscript(h, b.managerSessionId, a.managerToken);
    expect(r.statusCode).toBe(404);
    await teardown(h);
  });
});

describe("GET /agent/sessions/:id/transcript — empty + selection", () => {
  it("returns total=0 + empty entries when no transcript_path is set", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    const r = await fetchTranscript(h, boot.managerSessionId, boot.managerToken);
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.total).toBe(0);
    expect(body.entries).toEqual([]);
    expect(body.selection.kind).toBe("default");
    await teardown(h);
  });

  it("default selector returns the last 20 entries when no flags given", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    const lines: object[] = [];
    for (let i = 0; i < 25; i += 1) {
      lines.push({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `line ${i}` }] },
      });
    }
    writeTranscript(h, boot.managerSessionId, lines);
    const r = await fetchTranscript(h, boot.managerSessionId, boot.managerToken);
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.total).toBe(25);
    expect(body.entries).toHaveLength(20);
    expect(body.entries[0]!.id).toBe("5");
    expect(body.entries[19]!.id).toBe("24");
    expect(body.selection).toEqual({ kind: "default", n: 20 });
    await teardown(h);
  });

  it("--last N returns the last N entries", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(h, boot.managerSessionId, boot.managerToken, "last=2");
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.total).toBe(6);
    expect(body.entries.map((e) => e.id)).toEqual(["4", "5"]);
    expect(body.selection).toEqual({ kind: "last", n: 2 });
    await teardown(h);
  });

  it("--entry ID returns the single matching entry", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(h, boot.managerSessionId, boot.managerToken, "entry=2");
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.id).toBe("2");
    expect(body.selection).toEqual({ kind: "entry", id: "2" });
    await teardown(h);
  });

  it("--from ID --limit N slices forward", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(
      h,
      boot.managerSessionId,
      boot.managerToken,
      "from=1&limit=3",
    );
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.entries.map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(body.selection).toEqual({ kind: "from", id: "1", limit: 3 });
    await teardown(h);
  });

  it("--to ID --limit N slices backward (chronological order in result)", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(
      h,
      boot.managerSessionId,
      boot.managerToken,
      "to=4&limit=3",
    );
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.entries.map((e) => e.id)).toEqual(["2", "3", "4"]);
    expect(body.selection).toEqual({ kind: "to", id: "4", limit: 3 });
    await teardown(h);
  });

  it("returns 400 when multiple selectors are combined", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(
      h,
      boot.managerSessionId,
      boot.managerToken,
      "last=2&entry=1",
    );
    expect(r.statusCode).toBe(400);
    await teardown(h);
  });

  it("returns 404 when --entry ID is out of range", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(h, boot.managerSessionId, boot.managerToken, "entry=99");
    expect(r.statusCode).toBe(404);
    await teardown(h);
  });
});

describe("GET /agent/sessions/:id/transcript — detail levels", () => {
  it("detail=low returns only message turns, with role + content", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(
      h,
      boot.managerSessionId,
      boot.managerToken,
      "last=10&detail=low",
    );
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.entries.map((e) => e.id)).toEqual(["1", "2", "5"]);
    expect(body.entries[0]).toMatchObject({
      id: "1",
      role: "user",
      content: "first ask",
    });
    expect(body.entries[1]).toMatchObject({
      id: "2",
      role: "assistant",
      content: "thinking...",
    });
    expect(body.entries[2]).toMatchObject({
      id: "5",
      role: "assistant",
      content: "done",
    });
    for (const entry of body.entries) {
      expect(entry).not.toHaveProperty("summary");
      expect(entry).not.toHaveProperty("payload");
    }
    await teardown(h);
  });

  it("detail=medium (default) summarizes events and keeps message content", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(
      h,
      boot.managerSessionId,
      boot.managerToken,
      "last=10",
    );
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.entries).toHaveLength(6);
    const meta = body.entries.find((e) => e.id === "0");
    expect(meta!.summary).toBe("[permission-mode]");
    const message = body.entries.find((e) => e.id === "2");
    expect(message!.role).toBe("assistant");
    expect(message!.content).toBe("thinking...");
    expect(message).not.toHaveProperty("summary");
    const toolUse = body.entries.find((e) => e.id === "3");
    expect(toolUse!.summary).toContain("tool_use");
    expect(toolUse!.summary).toContain("Bash");
    expect(toolUse!.summary).toContain("ls -la");
    const toolResult = body.entries.find((e) => e.id === "4");
    expect(toolResult!.summary).toContain("tool_result");
    for (const entry of body.entries) {
      expect(entry).not.toHaveProperty("payload");
    }
    await teardown(h);
  });

  it("detail=full passes raw payloads through", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(
      h,
      boot.managerSessionId,
      boot.managerToken,
      "last=10&detail=full",
    );
    expect(r.statusCode).toBe(200);
    const body = r.body as TranscriptResponse;
    expect(body.entries).toHaveLength(6);
    const toolUse = body.entries.find((e) => e.id === "3");
    expect(toolUse!.payload).toEqual(SAMPLE_TRANSCRIPT[3] as Record<string, unknown>);
    const message = body.entries.find((e) => e.id === "2");
    expect(message!.payload).toEqual(SAMPLE_TRANSCRIPT[2] as Record<string, unknown>);
    await teardown(h);
  });

  it("returns 400 on invalid detail value", async () => {
    const h = buildHarness();
    const boot = await bootManager(h, repoPath);
    writeTranscript(h, boot.managerSessionId, SAMPLE_TRANSCRIPT);
    const r = await fetchTranscript(
      h,
      boot.managerSessionId,
      boot.managerToken,
      "detail=verbose",
    );
    expect(r.statusCode).toBe(400);
    await teardown(h);
  });
});
