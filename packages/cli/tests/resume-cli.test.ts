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
  endedSessionId: string;
  resumePrompts: Array<string | undefined>;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-resume-cli-"));
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
  const workerRole = roles.findInWorkspace(ws.id, "worker")!;

  const resumePrompts: Array<string | undefined> = [];
  let pidCounter = 8000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.resume === true) resumePrompts.push(req.prompt);
    return {
      sessionId: req.sessionId ?? randomUUID(),
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };

  // Manager session (the caller).
  const managerAgent = agents.create({ workspace_id: ws.id, role_id: managerRole.id });
  const managerSessionId = randomUUID();
  sessions.create({
    id: managerSessionId,
    agent_id: managerAgent.id,
    workspace_id: ws.id,
    role_id: managerRole.id,
    pid: 1,
  });
  const managerToken = tokens.mint(managerSessionId);

  // An ended, resumable worker session.
  const workerAgent = agents.create({ workspace_id: ws.id, role_id: workerRole.id });
  const endedSessionId = randomUUID();
  sessions.create({
    id: endedSessionId,
    agent_id: workerAgent.id,
    workspace_id: ws.id,
    role_id: workerRole.id,
    provider_thread_id: endedSessionId,
    pid: 2,
  });
  sessions.markEnded(endedSessionId);

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

  harness = {
    app,
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    managerToken,
    endedSessionId,
    resumePrompts,
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

describe("clobber CLI — resume", () => {
  it("`resume <session-id> --prompt` revives the session and forwards the prompt", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["resume", harness.endedSessionId, "--prompt", "open the PR now"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out()).toMatch(harness.endedSessionId);
    expect(harness.resumePrompts.some((p) => p?.includes("open the PR now"))).toBe(true);
  });

  it("exits 2 with usage when no session id is given", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["resume"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/session/i);
  });
});
