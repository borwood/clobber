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
import { createAgentQuestionStore } from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  managerSessionId: string;
  workspaceId: string;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-agents-cli-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const managerRole = roles.create({ name: "manager", persistent: true });
  workspaceRoles.setCeiling(ws.id, managerRole.id, 5);

  let pidCounter = 6000;
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
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) {
    throw new Error(`boot failed: ${bootRes.statusCode} ${bootRes.body}`);
  }
  const bootBody = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(bootBody.session_id);

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    managerSessionId: bootBody.session_id,
    workspaceId: ws.id,
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

describe("clobber CLI — agents", () => {
  it("`agents list` prints active agents JSON", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["agents", "list"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      agents: Array<{ session_id: string; is_caller: boolean }>;
    };
    expect(Array.isArray(parsed.agents)).toBe(true);
    const caller = parsed.agents.find((a) => a.session_id === harness.managerSessionId);
    expect(caller).toBeDefined();
    expect(caller!.is_caller).toBe(true);
  });

  it("exits 2 with usage when no subcommand is given", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["agents"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/subcommand/i);
  });

  it("exits 2 for an unknown subcommand", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["agents", "nope"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/nope/);
  });
});
