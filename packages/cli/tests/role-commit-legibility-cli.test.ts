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
import { DRIFT_STUB_API_BASE } from "@clobber/server/_drift-stub.ts";
import { run } from "../src/main.ts";

// #637 CLI-side:
// AC1: `roles commit` with no -m → exit 2 (CliUsageError; no default fallback).
// AC3: `roles log <name>` (no range) → exit 0 + JSON with entries[] branch changelog;
//      `roles log <name> @{upstream}..` → unchanged behavior.

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  roleRepoDir: string;
}

let harness: Harness;

function makeAgentStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-legibility-cli-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-legibility-cli-repo-"));
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pid = 9200;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pid += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid,
      exited: new Promise<number | null>(() => {}),
      stdin: makeAgentStdin(),
      kill: () => {},
    };
  };
  const app = createServer({
    db, store: createEventStore(db), workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db), roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db), agents: createAgentStore(db),
    sessions: createSessionStore(db),
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens, agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner, hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE, cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    roleRepoDir,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const wsRes = await app.inject({ method: "POST", url: "/workspaces",
    payload: { name: "ws", repo_path: repoPath } });
  if (wsRes.statusCode !== 201) throw new Error(`ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = db.prepare(
    "SELECT id FROM roles WHERE name = ? AND workspace_id = ?",
  ).get("manager", ws.id) as { id: string } | null;
  if (managerRow === null) throw new Error("manager seed missing");

  const bootRes = await app.inject({ method: "POST", url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "cli-test-agent" } });
  if (bootRes.statusCode !== 200) throw new Error(`spawn: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  harness = { app, db, baseUrl, managerToken, roleRepoDir };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.roleRepoDir, { recursive: true, force: true });
});

function capture() {
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

function env(): NodeJS.ProcessEnv {
  return { CLOBBER_API_BASE: harness.baseUrl, CLOBBER_SESSION_TOKEN: harness.managerToken };
}

describe("#637 CLI AC1: roles commit without -m → usage error", () => {
  it("exits 2 (CliUsageError) when -m is omitted", async () => {
    // First checkout so a commit attempt can be made
    const coS = capture();
    await run({ argv: ["roles", "checkout", "worker"], env: env(),
      stdout: coS.stdout, stderr: coS.stderr });

    const s = capture();
    const code = await run({
      argv: ["roles", "commit"],
      env: env(), stdout: s.stdout, stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/-m|message/i);

    // Discard to leave clean state for AC3 tests.
    await run({ argv: ["roles", "discard"], env: env(),
      stdout: capture().stdout, stderr: capture().stderr });
  });
});

describe("#637 CLI AC3: roles log <name> without range → branch changelog", () => {
  it("exits 2 (usage error) with @{upstream}.. missing range currently — confirm test proves current failure", async () => {
    // This is the CURRENT behavior that will be replaced.
    // After AC3, `roles log worker` with no range must exit 0.
    // Test is written to assert the NEW expected behavior: exit 0 + entries[].
    const coS = capture();
    await run({ argv: ["roles", "checkout", "worker"], env: env(),
      stdout: coS.stdout, stderr: coS.stderr });
    // Commit so there's something in the branch log.
    const cmS = capture();
    await run({ argv: ["roles", "commit", "-m", "cli-legibility-test-commit"], env: env(),
      stdout: cmS.stdout, stderr: cmS.stderr });

    const s = capture();
    const code = await run({
      argv: ["roles", "log", "worker", "--json"],
      env: env(), stdout: s.stdout, stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as { entries: unknown[] };
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("roles log <name> @{upstream}.. still works (legacy behavior unchanged)", async () => {
    const s = capture();
    const code = await run({
      argv: ["roles", "log", "worker", "@{upstream}..", "--json"],
      env: env(), stdout: s.stdout, stderr: s.stderr,
    });
    // Upstream not fetched → 422 (exit non-zero) or 200 with log string are both valid.
    // Key: must NOT error with a CLI usage error (exit 2 from CliUsageError).
    // After AC3 the @{upstream}.. path stays as a valid argument, not rejected.
    expect(code).not.toBe(2);
  });
});
