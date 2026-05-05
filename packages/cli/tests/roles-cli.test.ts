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
import { createAgentQuestionStore } from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { run, runWithExit } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  managerSessionId: string;
  workspaceId: string;
  workerRoleId: string;
  managerRoleId: string;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roles-cli-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  let pidCounter = 8000;
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
    managerSessionId: boot.session_id,
    workspaceId: ws.id,
    workerRoleId: workerRow.id,
    managerRoleId: managerRow.id,
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

describe("clobber CLI — roles list", () => {
  it("prints a table with manager + worker rows by default", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "list"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("manager");
    expect(out).toContain("worker");
    expect(out.toLowerCase()).toContain("name");
    expect(out.toLowerCase()).toContain("version");
  });

  it("prints JSON when --json is passed", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "list", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      roles: Array<{ name: string; persistent: boolean; version: number }>;
    };
    expect(Array.isArray(parsed.roles)).toBe(true);
    const names = parsed.roles.map((r) => r.name).sort();
    expect(names).toEqual(["manager", "worker"]);
    const manager = parsed.roles.find((r) => r.name === "manager");
    expect(manager!.persistent).toBe(true);
    expect(manager!.version).toBe(1);
  });

  it("exits 2 with a usage error when no subcommand is given", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/subcommand/i);
  });

  it("exits 2 for an unknown subcommand", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "nope"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/nope/);
  });
});

describe("clobber CLI — roles show", () => {
  it("prints a markdown view of the role by name", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "show", "worker"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("worker");
    expect(out.toLowerCase()).toContain("system prompt");
    expect(out.toLowerCase()).toContain("version 1");
  });

  it("looks up the role by id", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "show", harness.workerRoleId],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out()).toContain("worker");
  });

  it("prints JSON when --json is passed", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "show", "worker", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      id: string;
      name: string;
      current_version: { version: number; system_prompt: string };
      version_history: Array<{ version: number }>;
    };
    expect(parsed.name).toBe("worker");
    expect(parsed.id).toBe(harness.workerRoleId);
    expect(parsed.current_version.version).toBe(1);
    expect(parsed.current_version.system_prompt.length).toBeGreaterThan(0);
    expect(parsed.version_history).toHaveLength(1);
  });

  it("exits 2 when no name/id is given", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "show"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/name|id/i);
  });

  it("returns a non-zero exit when the role does not exist", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["roles", "show", "ghost-role-that-does-not-exist"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).not.toBe(0);
    expect(s.err()).toContain("not found");
  });

  it("renders a Triggers section with (none) when the role has no triggers", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "show", "worker"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("## Triggers");
    expect(out).toMatch(/## Triggers\n\(none\)/);
  });
});
