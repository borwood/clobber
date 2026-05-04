import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "@clobber/server/server.ts";
import { createDatabase } from "@clobber/server/db.ts";
import { createEventStore } from "@clobber/server/event-store.ts";
import { createWorkspaceStore } from "@clobber/server/workspace-store.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { createWorkspaceRoleStore } from "@clobber/server/workspace-role-store.ts";
import { createAgentStore } from "@clobber/server/agent-store.ts";
import { createSessionStore } from "@clobber/server/session-store.ts";
import { createWorkspaceSessionSummaries } from "@clobber/server/workspace-session-summaries.ts";
import { createSessionTokenStore } from "@clobber/server/session-token-store.ts";
import { createAgentStatusStore } from "@clobber/server/agent-status-store.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  managerSessionId: string;
  childSessionId: string;
  repoPath: string;
  tmp: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

const SAMPLE_TRANSCRIPT: object[] = [
  { type: "permission-mode", permissionMode: "default" },
  { type: "user", message: { role: "user", content: "ping" } },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "pong" }] },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a\nb\n" }],
    },
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "all good" }] },
  },
];

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-transcript-cli-"));
  const tmp = mkdtempSync(join(tmpdir(), "clobber-transcript-cli-data-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const managerRole = roles.create({ name: "manager", persistent: true });
  workspaceRoles.setCeiling(ws.id, managerRole.id, 5);

  let pidCounter = 8000;
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

  const app = createServer({
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
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot" },
  });
  const bootBody = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(bootBody.session_id);

  const childRes = await app.inject({
    method: "POST",
    url: "/agent/spawn",
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { role: "manager", prompt: "do work" },
  });
  const childBody = childRes.json() as { session_id: string };

  const transcriptPath = join(tmp, `${childBody.session_id}.jsonl`);
  writeFileSync(
    transcriptPath,
    SAMPLE_TRANSCRIPT.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  sessions.updateTranscriptPath(childBody.session_id, transcriptPath);

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    managerSessionId: bootBody.session_id,
    childSessionId: childBody.session_id,
    repoPath,
    tmp,
  };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
  rmSync(harness.tmp, { recursive: true, force: true });
});

function captureStreams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (c: Buffer) => out.push(c));
  stderr.on("data", (c: Buffer) => err.push(c));
  return {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    out: () => Buffer.concat(out).toString("utf8"),
    err: () => Buffer.concat(err).toString("utf8"),
  };
}

const env = () => ({
  CLOBBER_API_BASE: harness.baseUrl,
  CLOBBER_SESSION_TOKEN: harness.managerToken,
});

describe("clobber CLI — transcript", () => {
  it("default text output renders messages and event summaries", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["transcript", harness.childSessionId, "--last", "10"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("ping");
    expect(out).toContain("pong");
    expect(out).toContain("[tool_use");
    expect(out).toContain("Bash");
    expect(out).toContain("[tool_result");
  });

  it("--format json emits the raw JSON payload from the server", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["transcript", harness.childSessionId, "--last", "2", "--format", "json"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as { total: number; entries: unknown[] };
    expect(parsed.total).toBe(6);
    expect(parsed.entries).toHaveLength(2);
  });

  it("--detail low filters to message turns only", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "transcript",
        harness.childSessionId,
        "--last",
        "10",
        "--detail",
        "low",
        "--format",
        "json",
      ],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      entries: Array<{ id: string; role?: string; content?: string }>;
    };
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries.map((e) => e.id)).toEqual(["1", "2", "5"]);
  });

  it("--entry id selects a single entry", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "transcript",
        harness.childSessionId,
        "--entry",
        "3",
        "--detail",
        "full",
        "--format",
        "json",
      ],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      entries: Array<{ id: string; payload: { type: string } }>;
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.id).toBe("3");
    expect(parsed.entries[0]!.payload.type).toBe("assistant");
  });

  it("exits 2 with usage when no session id is given", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["transcript"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/session/i);
  });

  it("exits 2 when multiple selectors are combined", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "transcript",
        harness.childSessionId,
        "--last",
        "2",
        "--entry",
        "1",
      ],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/selector/i);
  });
});
