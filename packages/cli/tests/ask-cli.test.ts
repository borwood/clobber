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
import {
  createAgentQuestionStore,
  type AgentQuestionStore,
} from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  managerSessionId: string;
  questions: AgentQuestionStore;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-ask-cli-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const agentStatuses = createAgentStatusStore(db);
  const questions = createAgentQuestionStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const managerRole = roles.create({ name: "manager", persistent: true });
  workspaceRoles.setCeiling(ws.id, managerRole.id, 5);

  let pidCounter = 7000;
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
    agentStatuses,
    agentQuestions: questions,
    agentQuestionWaiter: createAgentQuestionWaiter(),
    askTimeoutMs: 200,
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

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    managerSessionId: bootBody.session_id,
    questions,
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

const env = () => ({
  CLOBBER_API_BASE: harness.baseUrl,
  CLOBBER_SESSION_TOKEN: harness.managerToken,
});

async function answerOpenQuestion(answer: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const open = harness.questions.getOpenForSession(harness.managerSessionId);
    if (open !== null) {
      await fetch(`${harness.baseUrl}/sessions/${harness.managerSessionId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_id: open.id, answer }),
      });
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("no open question appeared");
}

describe("clobber CLI — ask", () => {
  it("`ask <question>` blocks, prints the answer to stdout, and exits 0", async () => {
    const s = captureStreams();
    const askPromise = run({
      argv: ["ask", "ship it?"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    await answerOpenQuestion("yes");
    const code = await askPromise;
    expect(code).toBe(0);
    expect(s.out().trim()).toBe("yes");
    expect(s.err()).toBe("");
  });

  it("`ask <question> --option a --option b` records the options on the question row", async () => {
    const s = captureStreams();
    const askPromise = run({
      argv: ["ask", "merge or rebase?", "--option", "merge", "--option", "rebase"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });

    let openOptions: readonly string[] | undefined;
    for (let i = 0; i < 100; i++) {
      const open = harness.questions.getOpenForSession(harness.managerSessionId);
      if (open !== null) {
        openOptions = open.options;
        break;
      }
      await Bun.sleep(5);
    }
    expect(openOptions).toEqual(["merge", "rebase"]);

    await answerOpenQuestion("merge");
    const code = await askPromise;
    expect(code).toBe(0);
    expect(s.out().trim()).toBe("merge");
  });

  it("exits 1 with a stderr hint when the wait times out (no human answer)", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["ask", "anyone awake?"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(1);
    expect(s.out()).toBe("");
    expect(s.err()).toMatch(/timed out/i);
  });

  it("exits 2 when the question argument is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["ask"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/question/i);
  });

  it("`ask --help` prints usage to stdout and exits 0 (does NOT post a question)", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["ask", "--help"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out().toLowerCase()).toMatch(/usage|ask/);
    expect(s.err()).toBe("");

    // Critically: no question row was created.
    expect(harness.questions.getOpenForSession(harness.managerSessionId)).toBeNull();
  });

  it("`ask -h` behaves the same as --help", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["ask", "-h"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out().toLowerCase()).toMatch(/usage|ask/);
    expect(harness.questions.getOpenForSession(harness.managerSessionId)).toBeNull();
  });

  it("exits 2 when --option is given without a value", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["ask", "?", "--option"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/option/i);
  });
});
