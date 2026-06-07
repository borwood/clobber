import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
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
import type { SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { DRIFT_STUB_API_BASE } from "@clobber/server/_drift-stub.ts";
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  sessionId: string;
  token: string;
  workspaceId: string;
  roleId: string;
  roleName: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const ws = workspaces.create({ name: "ws", repo_path: "/r" });
  const role = roles.create({ name: "manager", persistent: false });
  workspaceRoles.setCeiling(ws.id, role.id, 1);
  const agent = agents.create({ workspace_id: ws.id, role_id: role.id });
  const session = sessions.create({
    id: randomUUID(),
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    pid: 1,
  });
  const token = tokens.mint(session.id);

  const stub: SpawnedAgentInfo = {
    sessionId: "stub",
    pid: 9000,
    exited: new Promise<number | null>(() => {}),
    stdin: makeStdin(),
    kill: () => {},
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
    spawner: () => ({ ...stub, sessionId: randomUUID() }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  harness = {
    app,
    db,
    baseUrl,
    sessionId: session.id,
    token,
    workspaceId: ws.id,
    roleId: role.id,
    roleName: role.name,
  };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
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

describe("clobber CLI — whoami", () => {
  it("prints session/workspace/role JSON on success", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["whoami"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.token,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      session_id: string;
      workspace_id: string;
      role: { name: string };
    };
    expect(parsed.session_id).toBe(harness.sessionId);
    expect(parsed.workspace_id).toBe(harness.workspaceId);
    expect(parsed.role.name).toBe(harness.roleName);
  });

  it("throws CliEnvError when CLOBBER_API_BASE is missing", async () => {
    const s = captureStreams();
    await expect(
      run({
        argv: ["whoami"],
        env: { CLOBBER_SESSION_TOKEN: harness.token },
        stdout: s.stdout,
        stderr: s.stderr,
      }),
    ).rejects.toThrow(/CLOBBER_API_BASE/);
  });

  it("throws CliEnvError when CLOBBER_SESSION_TOKEN is missing", async () => {
    const s = captureStreams();
    await expect(
      run({
        argv: ["whoami"],
        env: { CLOBBER_API_BASE: harness.baseUrl },
        stdout: s.stdout,
        stderr: s.stderr,
      }),
    ).rejects.toThrow(/CLOBBER_SESSION_TOKEN/);
  });
});

describe("clobber CLI — dispatch", () => {
  it("returns 0 and prints usage with no arguments", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.token,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out()).toMatch(/whoami/);
  });

  it("returns 2 for an unknown command", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["bogus"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.token,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/unknown command: bogus/);
  });
});
