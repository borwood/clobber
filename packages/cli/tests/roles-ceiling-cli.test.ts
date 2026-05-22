import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  workspaceId: string;
  workerRoleId: string;
  repoPath: string;
}

let harness: Harness;

function makeAgentStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roles-ceiling-cli-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);

  let pidCounter = 9700;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeAgentStdin(),
      kill: () => {},
    };
  };

  const app = createServer({
    db,
    store: createEventStore(db),
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
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

  const wsRes = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "ws", repo_path: repoPath },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  const workerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", ws.id) as { id: string } | null;
  if (managerRow === null || workerRow === null) {
    throw new Error("seed missing manager/worker");
  }

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    workspaceId: ws.id,
    workerRoleId: workerRow.id,
    repoPath,
  };
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

function envFor(token: string): NodeJS.ProcessEnv {
  return {
    CLOBBER_API_BASE: harness.baseUrl,
    CLOBBER_SESSION_TOKEN: token,
  };
}

function readCeiling(roleId: string): number | null {
  const row = harness.db
    .prepare(
      "SELECT max_concurrent FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?",
    )
    .get(harness.workspaceId, roleId) as { max_concurrent: number } | null;
  return row === null ? null : row.max_concurrent;
}

describe("clobber CLI — roles ceiling", () => {
  it("sets a ceiling on a role by name", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "ceiling", "worker", "11"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out()).toContain("worker");
    expect(s.out()).toContain("11");
    expect(readCeiling(harness.workerRoleId)).toBe(11);
  });

  it("sets a ceiling on a role by uuid", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "ceiling", harness.workerRoleId, "3"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(readCeiling(harness.workerRoleId)).toBe(3);
  });

  it("emits JSON when --json is passed", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "ceiling", "worker", "5", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      workspace_id: string;
      role_id: string;
      max_concurrent: number;
    };
    expect(parsed.role_id).toBe(harness.workerRoleId);
    expect(parsed.max_concurrent).toBe(5);
  });

  it("exits 2 when target is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "ceiling"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
  });

  it("exits 2 when ceiling number is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "ceiling", "worker"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
  });

  it("exits 2 when ceiling is not a non-negative integer", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "ceiling", "worker", "-3"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
  });
});
