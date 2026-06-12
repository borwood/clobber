import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "@clobber/server/server.ts";
import { createDatabase } from "@clobber/server/db.ts";
import { createEventStore } from "@clobber/server/event-store.ts";
import { createWorkspaceStore } from "@clobber/server/workspace-store.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { createRoleVersionStore } from "@clobber/server/role-version-store.ts";
import { createWorkspaceRoleStore } from "@clobber/server/workspace-role-store.ts";
import { createAgentStore } from "@clobber/server/agent-store.ts";
import { createSessionStore } from "@clobber/server/session-store.ts";
import { createWorkspaceSessionSummaries } from "@clobber/server/workspace-session-summaries.ts";
import { createSessionTokenStore } from "@clobber/server/session-token-store.ts";
import { createAgentStatusStore } from "@clobber/server/agent-status-store.ts";
import { createAgentStatusLogStore } from "@clobber/server/agent-status-log-store.ts";
import { createAgentQuestionStore } from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { seedWorkspaceRoles } from "@clobber/server/seed-workspace-roles.ts";
import { DRIFT_STUB_API_BASE } from "@clobber/server/_drift-stub.ts";
import { run } from "../src/main.ts";

// #632 — CLI-layer assertion: exhausted cycle retries must surface the real
// boot-failure reason on stderr, NOT the generic "internal server error" string
// that Fastify emits when an unhandled throw escapes the route handler.

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  repoPath: string;
  control: { failSpawns: boolean };
}

let harness: Harness;

function makeResumableStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-cycle-boot-fail-cli-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager")!;
  workspaceRoles.setCeiling(ws.id, managerRole.id, 1);

  const control = { failSpawns: false };
  let pidCounter = 8000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (control.failSpawns) {
      throw new Error("git worktree add failed (exit 128): fatal: '/tmp/wt' already exists");
    }
    pidCounter += 1;
    return {
      sessionId: req.sessionId!,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeResumableStdin(),
      kill: () => {},
    };
  };

  const app = createServer({
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
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    sleep: () => Promise.resolve(),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");

  const spawnRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boss" },
  });
  if (spawnRes.statusCode !== 200) throw new Error(`manager boot failed: ${spawnRes.body}`);
  const managerSessionId = (spawnRes.json() as { session_id: string }).session_id;
  const managerToken = tokens.mint(managerSessionId);

  harness = { app, db, baseUrl: `http://127.0.0.1:${addr.port}`, managerToken, repoPath, control };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
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

function env() {
  return {
    CLOBBER_API_BASE: harness.baseUrl,
    CLOBBER_SESSION_TOKEN: harness.managerToken,
  };
}

describe("clobber CLI — cycle boot failure (#632)", () => {
  it("cycle --token that exhausts all retries: stderr contains the real spawn error, not 'internal server error'", async () => {
    // Mint a cycle token via normal CLI path.
    const mintStreams = captureStreams();
    const mintCode = await run({
      argv: ["cycle", "--prompt", "HANDOFF: state in office notes"],
      env: env(),
      stdout: mintStreams.stdout,
      stderr: mintStreams.stderr,
    });
    expect(mintCode).toBe(0);

    // Extract the tool token from the DB (the minted row for the 'cycle' tool).
    const row = harness.db
      .prepare("SELECT token FROM tool_tokens WHERE tool = 'cycle' ORDER BY rowid DESC LIMIT 1")
      .get() as { token: string } | undefined;
    if (row === undefined) throw new Error("no cycle tool_token row found after mint");
    const toolToken = row.token;

    // Arm all subsequent spawns to fail — simulates git worktree add failures.
    harness.control.failSpawns = true;
    const s = captureStreams();
    const code = await run({
      argv: ["cycle", "--token", toolToken],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });

    // CLI must exit 1 (HTTP error path)
    expect(code).toBe(1);
    // stderr must contain the real spawn failure message, NOT a generic server error
    expect(s.err()).toContain("git worktree add failed");
    expect(s.err()).not.toContain("Internal Server Error");
    expect(s.err()).not.toContain("internal server error");

    harness.control.failSpawns = false;
  });
});
