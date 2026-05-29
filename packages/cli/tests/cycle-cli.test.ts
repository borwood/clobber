import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-cycle-cli-"));
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

  let pidCounter = 9000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    return {
      sessionId: req.sessionId ?? randomUUID(),
      pid: pidCounter,
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

  // Boot the manager through the spawn route so it is a LIVE registered session
  // (the mint path injects the brief into its transcript, which requires a live
  // child to write to — a bare session row would be reaped as ended).
  const spawnRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boss" },
  });
  if (spawnRes.statusCode !== 200) throw new Error(`manager boot failed: ${spawnRes.body}`);
  const managerSessionId = (spawnRes.json() as { session_id: string }).session_id;
  const managerToken = tokens.mint(managerSessionId);

  harness = {
    app,
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    managerToken,
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

function env() {
  return {
    CLOBBER_API_BASE: harness.baseUrl,
    CLOBBER_SESSION_TOKEN: harness.managerToken,
  };
}

describe("clobber CLI — cycle", () => {
  it("`cycle --prompt` (self) mints, no-ops, and returns an ack-only", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["cycle", "--prompt", "HANDOFF: continuity is in office notes"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    // The interjection (with the redemption token) goes to the transcript, never
    // back through the caller's return value.
    const out = JSON.parse(s.out()) as { ok: boolean; ack: string };
    expect(out.ok).toBe(true);
    expect(out.ack.length).toBeGreaterThan(0);
    expect(s.out()).not.toMatch(/--token \S/);
  });

  it("exits 2 when minting without a --prompt", async () => {
    const s = captureStreams();
    const code = await run({ argv: ["cycle"], env: env(), stdout: s.stdout, stderr: s.stderr });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/prompt/i);
  });

  it("exits 2 when --token is combined with mint flags", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["cycle", "--token", "abc", "--prompt", "x"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/token/i);
  });
});
