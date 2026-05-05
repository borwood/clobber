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
import { run, runWithExit } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
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
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roles-fork-cli-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  let pidCounter = 9100;
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
  if (managerRow === null) throw new Error("manager seed missing");

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  harness = { app, db, baseUrl, managerToken, workspaceId: ws.id, repoPath };
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

describe("clobber CLI — roles fork", () => {
  it("forks worker -> auditor and prints the new role id and name", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "fork", "worker", "auditor"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("auditor");

    const row = harness.db
      .prepare("SELECT id, name FROM roles WHERE name = ? AND workspace_id = ?")
      .get("auditor", harness.workspaceId) as { id: string; name: string } | null;
    expect(row).not.toBeNull();
    expect(out).toContain(row!.id);
  });

  it("returns JSON when --json is passed", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "fork", "worker", "auditor-json", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      role_id: string;
      version_id: string;
      version: number;
    };
    expect(typeof parsed.role_id).toBe("string");
    expect(typeof parsed.version_id).toBe("string");
    expect(parsed.version).toBe(1);
  });

  it("exits 2 when source name/id is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "fork"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/source|name|id/i);
  });

  it("exits 2 when new-name is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "fork", "worker"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/new[- ]?name/i);
  });

  it("surfaces a 409 with a useful message on duplicate name", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["roles", "fork", "worker", "manager"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).not.toBe(0);
    expect(s.err()).toMatch(/exists|already/i);
  });
});
