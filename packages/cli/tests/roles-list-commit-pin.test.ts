import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { createRoleContentCache } from "@clobber/server/role-content-cache.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { run } from "../src/main.ts";

// A minimal RoleTreeContract with non-empty allowedTools — used to pre-seed
// the materialized_role_cache so getOrLoad hits the cache and never touches git.
const PINNED_SHA = "abcdef012345678";
const PINNED_BRANCH = "main";
const PINNED_TOOLS = ["Bash", "Read", "Edit"];
const PINNED_CONTRACT = {
  framing: "You are a test role.",
  systemPrompt: "Test system prompt.",
  skills: [],
  allowedTools: PINNED_TOOLS,
  allowedCliCommands: [],
  hooks: "{}",
  triggers: [],
  seedRefs: [],
  wakePrograms: [],
  defaultWakeProgram: null,
  habits: [],
};

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  repoPath: string;
  pinnedRoleId: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roles-pin-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const db = createDatabase(":memory:");

  // Pre-seed the materialized_role_cache so a commit-pinned role resolves
  // without touching a real git repo.
  db.prepare(
    "INSERT INTO materialized_role_cache (sha, contract_json, contract_version, created_at) VALUES (?, ?, ?, ?)",
  ).run(PINNED_SHA, JSON.stringify(PINNED_CONTRACT), ENGINE_CONTRACT_VERSION, 0);

  const roleContentCache = createRoleContentCache(db);

  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  let pidCounter = 9000;
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
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    // Inject the pre-built cache so commit-pinned roles resolve without git.
    roleContentCache,
    roleRepoDir: "/fake-role-repo",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const wsRes = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "ws-pin", repo_path: repoPath },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  if (managerRow === null) throw new Error("seed missing manager");

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  // Insert a commit-pinned role directly into the DB. The role has no
  // role_versions row — embodiment reads its content from the cache.
  const pinnedRoleId = randomUUID();
  db.prepare(
    `INSERT INTO roles (id, name, persistent, workspace_id, current_commit_branch, current_commit_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(pinnedRoleId, "pinned-role", 0, ws.id, PINNED_BRANCH, PINNED_SHA, 0);

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    repoPath,
    pinnedRoleId,
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

describe("clobber CLI — roles list — commit pin + tools columns", () => {
  it("table has COMMIT header, not VERSION", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "list"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out.toUpperCase()).toContain("COMMIT");
    expect(out.toUpperCase()).not.toContain("VERSION");
  });

  it("table shows branch@sha7 for the commit-pinned role", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "list"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    const expected = `${PINNED_BRANCH}@${PINNED_SHA.slice(0, 7)}`;
    expect(out).toContain(expected);
  });

  it("table shows TOOLS for the commit-pinned role on the same line as its name", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "list"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    // Find the pinned-role row and assert its TOOLS column is non-empty.
    const pinnedLine = out.split("\n").find((l) => l.includes("pinned-role"));
    expect(pinnedLine).toBeDefined();
    expect(pinnedLine).toContain("Bash");
  });

  it("--json includes current_commit and allowed_tools for commit-pinned role", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "list", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      roles: Array<{
        name: string;
        current_commit?: { branch: string; sha: string };
        allowed_tools?: string[];
      }>;
    };
    const pinned = parsed.roles.find((r) => r.name === "pinned-role");
    expect(pinned).toBeDefined();
    expect(pinned!.current_commit).toEqual({ branch: PINNED_BRANCH, sha: PINNED_SHA });
    expect(pinned!.allowed_tools).toEqual(PINNED_TOOLS);
  });

  it("--json includes allowed_tools for row-backed roles (seeded manager)", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "list", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      roles: Array<{ name: string; allowed_tools?: string[] }>;
    };
    const manager = parsed.roles.find((r) => r.name === "manager");
    expect(manager).toBeDefined();
    // Manager inherits allowedTools from base — must be non-empty after fix.
    expect(Array.isArray(manager!.allowed_tools)).toBe(true);
    expect(manager!.allowed_tools!.length).toBeGreaterThan(0);
  });
});
