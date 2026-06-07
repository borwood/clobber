import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "@clobber/server/server.ts";
import { loadRoleContractAtCommit } from "@clobber/server/role-repo.ts";
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
import type { PromptModuleRef, WakeProgram } from "@clobber/shared";
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  workspaceId: string;
  workerRoleId: string;
  repoPath: string;
  tmpDir: string;
  roleRepoDir: string;
}

let harness: Harness;

function makeAgentStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roles-seeds-cli-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const tmpDir = mkdtempSync(join(tmpdir(), "clobber-roles-seeds-files-"));
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-roles-seeds-repo-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  let pidCounter = 9600;
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
    apiBase: DRIFT_STUB_API_BASE,
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
    workspaceId: ws.id,
    workerRoleId: workerRow.id,
    repoPath,
    tmpDir,
    roleRepoDir,
  };
});

afterAll(async () => {
  if ((harness as Harness | undefined) === undefined) return;
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
  rmSync(harness.tmpDir, { recursive: true, force: true });
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

// #414 — the worker is commit-pinned; prompt-module/wake-program edits advance the pin.
// Read prompt_module_refs + wake_programs from the contract at the current pin (the clone
// once it exists, else the upstream repo at the seeded sha).
function readWorker(): {
  sha: string;
  prompt_module_refs: readonly PromptModuleRef[];
  wake_programs: readonly WakeProgram[];
} {
  const row = harness.db
    .prepare("SELECT current_commit_sha AS sha FROM roles WHERE id = ?")
    .get(harness.workerRoleId) as { sha: string | null };
  if (row.sha === null) throw new Error("worker is not commit-pinned");
  const clone = join(dirname(harness.roleRepoDir), "role-repos", harness.workspaceId);
  const dir = existsSync(join(clone, ".git")) ? clone : harness.roleRepoDir;
  const contract = loadRoleContractAtCommit(dir, row.sha);
  return { sha: row.sha, prompt_module_refs: contract.seedRefs, wake_programs: contract.wakePrograms };
}

async function cli(args: readonly string[]) {
  const s = captureStreams();
  const code = await run({
    argv: args,
    env: envFor(harness.managerToken),
    stdout: s.stdout,
    stderr: s.stderr,
  });
  return { code, out: s.out(), err: s.err() };
}

describe("clobber CLI — boot integrity", () => {
  it("manager spawn through harness returns 200 (apiBase self-HTTP reachability guard)", () => {
    // harness is only assigned when beforeAll's spawn returned 200.
    // A regression where apiBase is unreachable causes spawn to return 500,
    // beforeAll to throw, harness to stay undefined, and this test to fail.
    expect((harness as Harness | undefined)).toBeDefined();
    expect(harness.managerToken).toBeString();
    expect(harness.managerToken.length).toBeGreaterThan(0);
  });
});

describe("clobber CLI — roles seeds", () => {
  it("adds a seed ref and advances the pin", async () => {
    const before = readWorker();
    const r = await cli(["roles", "prompt-modules", "worker", "add", "office-manifest"]);
    expect(r.code).toBe(0);

    const after = readWorker();
    expect(after.sha).not.toBe(before.sha);
    expect(after.prompt_module_refs).toContainEqual({ name: "office-manifest", enabled: true });
  });

  it("adds a disabled seed ref with --disabled", async () => {
    const r = await cli(["roles", "prompt-modules", "worker", "add", "wisdom-pointer", "--disabled"]);
    expect(r.code).toBe(0);
    const after = readWorker();
    expect(after.prompt_module_refs).toContainEqual({ name: "wisdom-pointer", enabled: false });
  });

  it("lists seeds with their enabled state", async () => {
    const r = await cli(["roles", "prompt-modules", "worker"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("office-manifest");
    expect(r.out).toContain("wisdom-pointer");
  });

  it("disable then enable toggles the ref", async () => {
    const dis = await cli(["roles", "prompt-modules", "worker", "disable", "repo-sdlc"]);
    expect(dis.code).toBe(0);
    expect(readWorker().prompt_module_refs).toContainEqual({ name: "repo-sdlc", enabled: false });

    const en = await cli(["roles", "prompt-modules", "worker", "enable", "repo-sdlc"]);
    expect(en.code).toBe(0);
    expect(readWorker().prompt_module_refs).toContainEqual({ name: "repo-sdlc", enabled: true });
  });

  it("exits 2 when toggling a seed that is not on the role", async () => {
    const r = await cli(["roles", "prompt-modules", "worker", "enable", "no-such-seed"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no-such-seed|not.*ref|not on/i);
  });
});

describe("clobber CLI — roles wake-programs", () => {
  it("adds a wake-program with system addon and a user kick", async () => {
    const before = readWorker();
    const r = await cli([
      "roles",
      "wake-programs",
      "worker",
      "add",
      "triage",
      "--system",
      "Regardless of the first message, triage the queue first.",
      "--user",
      "Triage the inbound queue now.",
    ]);
    expect(r.code).toBe(0);

    const after = readWorker();
    expect(after.sha).not.toBe(before.sha);
    expect(after.wake_programs).toContainEqual({
      name: "triage",
      system: "Regardless of the first message, triage the queue first.",
      user: "Triage the inbound queue now.",
    });
  });

  it("adds a wake-program with --no-user (null kick)", async () => {
    const r = await cli([
      "roles",
      "wake-programs",
      "worker",
      "add",
      "watch",
      "--system",
      "Watch and report.",
      "--no-user",
    ]);
    expect(r.code).toBe(0);
    expect(readWorker().wake_programs).toContainEqual({
      name: "watch",
      system: "Watch and report.",
      user: null,
    });
  });

  it("lists wake-programs including the idle built-in", async () => {
    const r = await cli(["roles", "wake-programs", "worker"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("idle");
    expect(r.out).toContain("triage");
    expect(r.out).toContain("watch");
  });

  it("shows a single wake-program's system and user channels", async () => {
    const r = await cli(["roles", "wake-programs", "worker", "show", "triage"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("triage the queue first");
    expect(r.out).toContain("Triage the inbound queue now.");
  });

  it("edits an existing wake-program's user kick", async () => {
    const r = await cli([
      "roles",
      "wake-programs",
      "worker",
      "edit",
      "triage",
      "--user",
      "Triage and escalate.",
    ]);
    expect(r.code).toBe(0);
    const triage = readWorker().wake_programs.find((p) => p.name === "triage");
    expect(triage?.user).toBe("Triage and escalate.");
    expect(triage?.system).toBe(
      "Regardless of the first message, triage the queue first.",
    );
  });

  it("removes a wake-program", async () => {
    const r = await cli(["roles", "wake-programs", "worker", "remove", "watch"]);
    expect(r.code).toBe(0);
    expect(readWorker().wake_programs.find((p) => p.name === "watch")).toBeUndefined();
  });

  it("exits 2 when adding a wake-program that already exists", async () => {
    const r = await cli([
      "roles",
      "wake-programs",
      "worker",
      "add",
      "triage",
      "--system",
      "dup",
      "--no-user",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/exists|already/i);
  });

  it("exits 2 when adding a wake-program named idle (reserved built-in)", async () => {
    const r = await cli([
      "roles",
      "wake-programs",
      "worker",
      "add",
      "idle",
      "--system",
      "x",
      "--no-user",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/idle|reserved|built-in/i);
  });

  it("exits 2 when editing a wake-program that does not exist", async () => {
    const r = await cli([
      "roles",
      "wake-programs",
      "worker",
      "edit",
      "ghost",
      "--user",
      "x",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/ghost|not found|no.*program/i);
  });
});
