import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PassThrough, Readable } from "node:stream";
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
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-roles-edit-cli-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const tmpDir = mkdtempSync(join(tmpdir(), "clobber-roles-edit-files-"));
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-roles-edit-repo-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  let pidCounter = 9400;
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

// #414 — the worker is commit-pinned; an edit advances the pin (no version row).
function workerPinSha(): string {
  const row = harness.db
    .prepare("SELECT current_commit_sha AS sha FROM roles WHERE id = ?")
    .get(harness.workerRoleId) as { sha: string | null };
  if (row.sha === null) throw new Error("worker is not commit-pinned");
  return row.sha;
}

// Read the worker's contract at its current pin. The seeded pin resolves from the
// upstream repo until the first edit clones the per-workspace repo; thereafter
// every advanced pin (and the seeded objects, copied at clone time) resolves there.
function workerContract() {
  const clone = join(dirname(harness.roleRepoDir), "role-repos", harness.workspaceId);
  const dir = existsSync(join(clone, ".git")) ? clone : harness.roleRepoDir;
  return loadRoleContractAtCommit(dir, workerPinSha());
}

function workerVersionRowCount(): number {
  return (
    harness.db
      .prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?")
      .get(harness.workerRoleId) as { n: number }
  ).n;
}

function managerTriggers(): readonly unknown[] {
  const row = harness.db
    .prepare(
      "SELECT current_commit_sha AS sha FROM roles WHERE name = 'manager' AND workspace_id = ?",
    )
    .get(harness.workspaceId) as { sha: string | null };
  if (row.sha === null) throw new Error("manager is not commit-pinned");
  const clone = join(dirname(harness.roleRepoDir), "role-repos", harness.workspaceId);
  const dir = existsSync(join(clone, ".git")) ? clone : harness.roleRepoDir;
  return loadRoleContractAtCommit(dir, row.sha).triggers;
}

describe("clobber CLI — roles edit", () => {
  it("--system-prompt-file replaces the prompt and bumps the version", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "prompt-file.md");
    writeFileSync(file, "you are a careful auditor\n");

    const beforeSha = workerPinSha();

    const code = await run({
      argv: ["roles", "edit", "worker", "--system-prompt-file", file],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out()).toContain("worker");

    expect(workerPinSha()).not.toBe(beforeSha);
    expect(workerContract().systemPrompt).toBe("you are a careful auditor\n");
    expect(workerVersionRowCount()).toBe(0);
  });

  it("--system-prompt - reads from stdin", async () => {
    const s = captureStreams();
    const stdin = Readable.from(["stdin-prompt-content\n"]);

    const beforeSha = workerPinSha();

    const code = await run({
      argv: ["roles", "edit", "worker", "--system-prompt", "-"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
      stdin: stdin as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(0);

    expect(workerPinSha()).not.toBe(beforeSha);
    expect(workerContract().systemPrompt).toBe("stdin-prompt-content\n");
  });

  it("--allowed-tools replaces the tool set", async () => {
    const s = captureStreams();
    const beforeSha = workerPinSha();

    const code = await run({
      argv: ["roles", "edit", "worker", "--allowed-tools", "Read,Grep,Bash"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    expect(workerPinSha()).not.toBe(beforeSha);
    expect(workerContract().allowedTools).toEqual(["Read", "Grep", "Bash"]);
  });

  it("--add-skill is repeatable and appends new skills", async () => {
    const s = captureStreams();
    const skillA = join(harness.tmpDir, "skill-a.md");
    const skillB = join(harness.tmpDir, "skill-b.md");
    writeFileSync(skillA, "# A skill body");
    writeFileSync(skillB, "# B skill body");

    const beforeNames = workerContract().skills.map((sk) => sk.name);

    const code = await run({
      argv: [
        "roles",
        "edit",
        "worker",
        "--add-skill",
        `aaa=${skillA}`,
        "--add-skill",
        `bbb=${skillB}`,
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const afterSkills = workerContract().skills;
    const afterNames = afterSkills.map((sk) => sk.name);
    // The contract canonicalizes skills by name, so assert membership, not order.
    expect(afterNames).toEqual([...beforeNames, "aaa", "bbb"].sort());
    const aaa = afterSkills.find((sk) => sk.name === "aaa");
    const bbb = afterSkills.find((sk) => sk.name === "bbb");
    expect(aaa?.body).toBe("# A skill body");
    expect(bbb?.body).toBe("# B skill body");
  });

  it("--remove-skill drops named skills from the current set", async () => {
    const s = captureStreams();

    const target = workerContract().skills.find((sk) => sk.name === "aaa");
    expect(target).toBeDefined();
    const beforeSha = workerPinSha();

    const code = await run({
      argv: ["roles", "edit", "worker", "--remove-skill", "aaa"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    expect(workerPinSha()).not.toBe(beforeSha);
    expect(workerContract().skills.map((sk) => sk.name)).not.toContain("aaa");
  });

  it("--json prints the patch result", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "json-prompt.md");
    writeFileSync(file, "json mode prompt");

    const code = await run({
      argv: [
        "roles",
        "edit",
        "worker",
        "--system-prompt-file",
        file,
        "--json",
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      role_id: string;
      branch: string;
      sha: string;
      no_new_version: boolean;
    };
    expect(parsed.role_id).toBe(harness.workerRoleId);
    expect(typeof parsed.sha).toBe("string");
    expect(typeof parsed.branch).toBe("string");
    expect(parsed.no_new_version).toBe(true);
  });

  it("--description updates roles.description without advancing the pin", async () => {
    const s = captureStreams();
    const beforeSha = workerPinSha();

    const code = await run({
      argv: ["roles", "edit", "worker", "--description", "the new desc"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    expect(workerPinSha()).toBe(beforeSha);

    const descRow = harness.db
      .prepare("SELECT description FROM roles WHERE id = ?")
      .get(harness.workerRoleId) as { description: string };
    expect(descRow.description).toBe("the new desc");
  });

  it("--description-file reads the description from a file", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "desc.md");
    writeFileSync(file, "rich\nmultiline\ndesc\n");

    const code = await run({
      argv: ["roles", "edit", "worker", "--description-file", file],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const descRow = harness.db
      .prepare("SELECT description FROM roles WHERE id = ?")
      .get(harness.workerRoleId) as { description: string };
    expect(descRow.description).toBe("rich\nmultiline\ndesc\n");
  });

  it("exits 2 when both --description and --description-file are passed", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "desc-conflict.md");
    writeFileSync(file, "x");
    const code = await run({
      argv: [
        "roles",
        "edit",
        "worker",
        "--description",
        "x",
        "--description-file",
        file,
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/description/i);
  });

  it("exits 2 when target name/id is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "edit", "--system-prompt-file", "/dev/null"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/name|id|target/i);
  });

  it("exits 2 when no edit flags are provided", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "edit", "worker"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/no edits|edit|flag/i);
  });

  it("exits 2 when both --system-prompt-file and --system-prompt are passed", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "x.md");
    writeFileSync(file, "x");
    const code = await run({
      argv: [
        "roles",
        "edit",
        "worker",
        "--system-prompt-file",
        file,
        "--system-prompt",
        "-",
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/system-prompt|conflict|both/i);
  });

  it("--triggers JSON sets triggers on a persistent role", async () => {
    const s = captureStreams();
    const triggers = [{ kind: "cron", expr: "0 9 * * *" }];

    const code = await run({
      argv: [
        "roles",
        "edit",
        "manager",
        "--triggers",
        JSON.stringify(triggers),
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    expect(managerTriggers()).toEqual(triggers);
  });

  it("--triggers-file reads triggers from a JSON file", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "triggers.json");
    const triggers = [{ kind: "webhook", path: "/hooks/triage" }];
    writeFileSync(file, JSON.stringify(triggers));

    const code = await run({
      argv: ["roles", "edit", "manager", "--triggers-file", file],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    expect(managerTriggers()).toEqual(triggers);
  });

  it("--triggers on an ephemeral role surfaces the 422 from the server", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "roles",
        "edit",
        "worker",
        "--triggers",
        '[{"kind":"cron","expr":"0 9 * * *"}]',
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(1);
    expect(s.err()).toMatch(/persistent/i);
  });

  it("exits 2 when both --triggers and --triggers-file are passed", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "triggers-conflict.json");
    writeFileSync(file, "[]");
    const code = await run({
      argv: [
        "roles",
        "edit",
        "manager",
        "--triggers",
        "[]",
        "--triggers-file",
        file,
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/triggers/i);
  });

  it("exits 2 when --triggers value is not a JSON array", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "edit", "manager", "--triggers", '{"kind":"cron"}'],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/array/i);
  });

  it("exits 2 when --triggers value is not valid JSON", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["roles", "edit", "manager", "--triggers", "not json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/json/i);
  });
});
