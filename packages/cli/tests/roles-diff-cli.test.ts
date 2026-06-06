import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
import { run } from "../src/main.ts";

// #441 — `roles diff` must show line-level changes, not just filenames. This
// integration test exercises the full CLI flow: checkout → edit → diff → assert
// the output contains content hunks (+/- lines), not just `modified <file>`.

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  repoPath: string;
  roleRepoDir: string;
}

let harness: Harness;

function makeAgentStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roles-diff-cli-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-roles-diff-cli-repo-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  let pidCounter = 9300;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeAgentStdin(),
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
    roleRepoDir,
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
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
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  harness = { app, db, baseUrl, managerToken, repoPath, roleRepoDir };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
  rmSync(harness.roleRepoDir, { recursive: true, force: true });
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

describe("clobber CLI — roles diff (#441)", () => {
  it("shows line-level content hunks after editing a checkout file (not just filename)", async () => {
    // Step 1: checkout worker role
    const coStreams = captureStreams();
    const coCode = await run({
      argv: ["roles", "checkout", "worker", "--json"],
      env: envFor(harness.managerToken),
      stdout: coStreams.stdout,
      stderr: coStreams.stderr,
    });
    expect(coCode, coStreams.err()).toBe(0);
    const co = JSON.parse(coStreams.out()) as { checkout_dir: string };

    // Step 2: edit system-prompt.md in the checkout
    const promptPath = join(co.checkout_dir, "system-prompt.md");
    const original = readFileSync(promptPath, "utf8");
    writeFileSync(promptPath, `${original}\n# ADDED BY DIFF TEST\n`);

    // Step 3: run `roles diff` — must show line-level hunks, not just the filename
    const diffStreams = captureStreams();
    const diffCode = await run({
      argv: ["roles", "diff"],
      env: envFor(harness.managerToken),
      stdout: diffStreams.stdout,
      stderr: diffStreams.stderr,
    });
    expect(diffCode, diffStreams.err()).toBe(0);

    const out = diffStreams.out();
    // Must contain a hunk line — an added line starting with '+'
    expect(out).toMatch(/^\+[^+]/m);
    // Must show the actual added content
    expect(out).toContain("+# ADDED BY DIFF TEST");
    // Must NOT be only a name-only list (old behavior was "  modified  system-prompt.md")
    expect(out).not.toMatch(/^\s+modified\s+system-prompt\.md\s*$/m);
  });

  it("--stat flag shows name-only list without content hunks", async () => {
    // Step 1: checkout worker role (reuse the open checkout from the previous test,
    // or open a fresh one if discard happened — open-ended, so we open a new one via
    // a fresh discard + checkout cycle).
    const discardStreams = captureStreams();
    await run({
      argv: ["roles", "discard"],
      env: envFor(harness.managerToken),
      stdout: discardStreams.stdout,
      stderr: discardStreams.stderr,
    });

    const coStreams = captureStreams();
    const coCode = await run({
      argv: ["roles", "checkout", "worker", "--json"],
      env: envFor(harness.managerToken),
      stdout: coStreams.stdout,
      stderr: coStreams.stderr,
    });
    expect(coCode, coStreams.err()).toBe(0);
    const co = JSON.parse(coStreams.out()) as { checkout_dir: string };

    // Edit the checkout
    const promptPath = join(co.checkout_dir, "system-prompt.md");
    const original = readFileSync(promptPath, "utf8");
    writeFileSync(promptPath, `${original}\n# STAT TEST CHANGE\n`);

    // Run `roles diff --stat` — must show filenames only, no hunk lines
    const diffStreams = captureStreams();
    const diffCode = await run({
      argv: ["roles", "diff", "--stat"],
      env: envFor(harness.managerToken),
      stdout: diffStreams.stdout,
      stderr: diffStreams.stderr,
    });
    expect(diffCode, diffStreams.err()).toBe(0);

    const out = diffStreams.out();
    // Must mention the changed file
    expect(out).toContain("system-prompt.md");
    // Must NOT contain hunk lines (no lines starting with '+' followed by non-'+')
    expect(out).not.toMatch(/^\+[^+]/m);
  });
});
