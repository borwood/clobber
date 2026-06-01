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
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import type {
  AgentSpawner,
  AgentSpawnRequest,
  SpawnedAgentInfo,
} from "@clobber/server/types.ts";
import { run, runWithExit } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  workspaceId: string;
  spawnerCalls: AgentSpawnRequest[];
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-spawn-cli-"));
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
  workspaceRoles.setCeiling(ws.id, managerRole.id, 20);

  const spawnerCalls: AgentSpawnRequest[] = [];
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    spawnerCalls.push(req);
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 7777,
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
    workspaceId: ws.id,
    spawnerCalls,
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

describe("clobber CLI — spawn", () => {
  it("posts to /agent/spawn and prints session info JSON on success", async () => {
    const s = captureStreams();
    const before = harness.spawnerCalls.length;
    const code = await run({
      argv: ["spawn", "manager", "--prompt", "audit auth.ts", "--label", "audit-auth"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      session_id: string;
      agent_id: string;
      pid: number;
    };
    expect(typeof parsed.session_id).toBe("string");
    expect(typeof parsed.agent_id).toBe("string");
    expect(parsed.pid).toBe(7777);

    expect(harness.spawnerCalls.length).toBe(before + 1);
    const call = harness.spawnerCalls[harness.spawnerCalls.length - 1]!;
    // Manager is persistent → office-context prefix prepended; user prompt is the suffix.
    expect(call.prompt!.endsWith("audit auth.ts")).toBe(true);
    expect(call.cwd).toBe(harness.repoPath);
  });

  it("forwards --label to the API", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "spawn",
        "manager",
        "--prompt",
        "double-check the math",
        "--label",
        "math-checker",
      ],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as { session_id: string; agent_id: string };
    expect(typeof parsed.session_id).toBe("string");
  });

  it("exits 2 with a usage hint when role positional is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["spawn"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/role/i);
  });

  it("exits 2 with a usage hint when --prompt is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["spawn", "manager"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--prompt/);
  });

  it("exits 2 when --prompt is given without a value", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["spawn", "manager", "--prompt"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--prompt/);
  });

  it("exits 2 with a usage hint when --label is missing (#36)", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["spawn", "manager", "--prompt", "audit auth.ts"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--label/);
  });

  it("exits 2 when --label is given without a value", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["spawn", "manager", "--prompt", "x", "--label"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--label/);
  });

  it("forwards --effort to the spawner so a manager can override per-assignment", async () => {
    const s = captureStreams();
    const before = harness.spawnerCalls.length;
    const code = await run({
      argv: [
        "spawn",
        "manager",
        "--prompt",
        "deep dive on this hairy migration",
        "--label",
        "migration-research",
        "--effort",
        "max",
      ],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(harness.spawnerCalls.length).toBe(before + 1);
    const call = harness.spawnerCalls[harness.spawnerCalls.length - 1]!;
    expect(call.effort).toBe("max");
  });

  it("forwards --model to the spawner so a manager can route a worker to a cheaper model", async () => {
    const s = captureStreams();
    const before = harness.spawnerCalls.length;
    const code = await run({
      argv: [
        "spawn",
        "manager",
        "--prompt",
        "mechanical transcription, route to sonnet",
        "--label",
        "cheap-lane",
        "--model",
        "sonnet",
      ],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(harness.spawnerCalls.length).toBe(before + 1);
    const call = harness.spawnerCalls[harness.spawnerCalls.length - 1]!;
    expect(call.model).toBe("sonnet");
  });

  it.each(["default", "best", "sonnet[1m]", "opus[1m]", "opusplan"])(
    "accepts extended model alias: %s",
    async (alias) => {
      const s = captureStreams();
      const before = harness.spawnerCalls.length;
      const code = await run({
        argv: [
          "spawn",
          "manager",
          "--prompt",
          "x",
          "--label",
          `alias-${alias.replace(/[\[\]]/g, "")}`,
          "--model",
          alias,
        ],
        env: {
          CLOBBER_API_BASE: harness.baseUrl,
          CLOBBER_SESSION_TOKEN: harness.managerToken,
        },
        stdout: s.stdout,
        stderr: s.stderr,
      });
      expect(code).toBe(0);
      expect(harness.spawnerCalls.length).toBe(before + 1);
      const call = harness.spawnerCalls[harness.spawnerCalls.length - 1]!;
      expect(call.model).toBe(alias);
    },
  );

  it("accepts a full claude-* API model name (e.g. claude-opus-4-8)", async () => {
    const s = captureStreams();
    const before = harness.spawnerCalls.length;
    const code = await run({
      argv: [
        "spawn",
        "manager",
        "--prompt",
        "x",
        "--label",
        "full-api-name",
        "--model",
        "claude-opus-4-8",
      ],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(harness.spawnerCalls.length).toBe(before + 1);
    const call = harness.spawnerCalls[harness.spawnerCalls.length - 1]!;
    expect(call.model).toBe("claude-opus-4-8");
  });

  it("rejects --model values outside the model enum", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "spawn",
        "manager",
        "--prompt",
        "x",
        "--label",
        "bad-model",
        "--model",
        "gpt-4",
      ],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--model/);
  });

  it("error message on bad model value names all aliases and the claude-* shape", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "spawn",
        "manager",
        "--prompt",
        "x",
        "--label",
        "bad-model-msg",
        "--model",
        "claud-opus",
      ],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    const errText = s.err();
    expect(errText).toMatch(/opusplan/);
    expect(errText).toMatch(/claude-\*/);
  });

  it("rejects --effort values outside the claude --effort enum", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "spawn",
        "manager",
        "--prompt",
        "x",
        "--label",
        "bad-effort",
        "--effort",
        "ludicrous",
      ],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--effort/);
  });

  it("surfaces the API error body when the role is unknown", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["spawn", "ghost-role", "--prompt", "do x", "--label", "boot"],
      env: {
        CLOBBER_API_BASE: harness.baseUrl,
        CLOBBER_SESSION_TOKEN: harness.managerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(1);
    expect(s.err()).toMatch(/role not found/i);
  });
});
