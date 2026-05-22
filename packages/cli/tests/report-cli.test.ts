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
import { run, runWithExit } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  workerToken: string;
  workerSessionId: string;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-report-cli-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const workerRole = roles.create({ name: "worker", persistent: false });
  workspaceRoles.setCeiling(ws.id, workerRole.id, 5);

  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9999,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
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
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: workerRole.id, prompt: "boot", label: "boot" },
  });
  const bootBody = bootRes.json() as { session_id: string };
  const workerToken = tokens.mint(bootBody.session_id);

  harness = { app, db, baseUrl, workerToken, workerSessionId: bootBody.session_id, repoPath };
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

const env = () => ({
  CLOBBER_API_BASE: harness.baseUrl,
  CLOBBER_SESSION_TOKEN: harness.workerToken,
});

interface ReportRow {
  details_json: string;
}

function fetchReport(): ReportRow | null {
  const row = harness.db
    .prepare(
      "SELECT details_json FROM agent_status_log WHERE session_id = ? AND kind = 'final-report' ORDER BY created_at DESC LIMIT 1",
    )
    .get(harness.workerSessionId) as ReportRow | null;
  return row;
}

describe("clobber CLI — report", () => {
  it("`report --well X --badly Y --useful Z` writes a structured report and exits 0", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "report",
        "--well", "tests passed first try",
        "--badly", "underestimated how long the explore would take",
        "--useful", "a /assignment skill",
      ],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const row = fetchReport();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.details_json)).toEqual({
      well: "tests passed first try",
      badly: "underestimated how long the explore would take",
      useful: "a /assignment skill",
    });
  });

  it("rejects calling report twice in the same session with non-zero exit", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["report", "--well", "second attempt"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).not.toBe(0);
    expect(s.err()).toMatch(/already submitted/i);
  });
});

describe("clobber CLI — report — fresh session", () => {
  let secondHarness: Harness;

  beforeAll(async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-report-cli2-"));
    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const roleVersions = createRoleVersionStore(db);
    const workspaceRoles = createWorkspaceRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const tokens = createSessionTokenStore(db);

    const ws = workspaces.create({ name: "ws", repo_path: repoPath });
    const workerRole = roles.create({ name: "worker", persistent: false });
    workspaceRoles.setCeiling(ws.id, workerRole.id, 5);

    const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
      if (req.sessionId === undefined) throw new Error("expected sessionId");
      return {
        sessionId: req.sessionId,
        pid: 9999,
        exited: new Promise<number | null>(() => {}),
        stdin: makeStdin(),
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
      apiBase: "http://test.invalid",
      cliEntry: "/dummy/cli.ts",
      dispatches: createTriggerDispatchStore(db),
      finalReportConsumerState: createFinalReportConsumerStateStore(db),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const bootRes = await app.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: workerRole.id, prompt: "boot", label: "boot" },
    });
    const bootBody = bootRes.json() as { session_id: string };
    const workerToken = tokens.mint(bootBody.session_id);

    secondHarness = { app, db, baseUrl, workerToken, workerSessionId: bootBody.session_id, repoPath };
  });

  afterAll(async () => {
    await secondHarness.app.close();
    secondHarness.db.close();
    rmSync(secondHarness.repoPath, { recursive: true, force: true });
  });

  function envFresh() {
    return {
      CLOBBER_API_BASE: secondHarness.baseUrl,
      CLOBBER_SESSION_TOKEN: secondHarness.workerToken,
    };
  }

  it("`report '<free text>'` writes a free_text report", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["report", "shipped, no notes"],
      env: envFresh(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const row = secondHarness.db
      .prepare(
        "SELECT details_json FROM agent_status_log WHERE session_id = ? AND kind = 'final-report'",
      )
      .get(secondHarness.workerSessionId) as { details_json: string } | null;
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.details_json)).toEqual({ free_text: "shipped, no notes" });
  });
});

describe("clobber CLI — report — usage errors", () => {
  it("exits 2 when no content is provided", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["report"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/well|badly|useful|summary/i);
  });

  it("exits 2 when --well is given without a value", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["report", "--well"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
  });

  it("exits 2 when positional summary is mixed with --well", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["report", "--well", "x", "free positional"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
  });
});
