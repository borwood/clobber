import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
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
  };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
  rmSync(harness.tmpDir, { recursive: true, force: true });
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

function readWorkerVersion(): { version: number; system_prompt: string; skills_json: string; allowed_tools_json: string } {
  const row = harness.db
    .prepare(
      `SELECT v.version, v.system_prompt, v.skills_json, v.allowed_tools_json
       FROM role_versions v JOIN roles r ON r.current_version_id = v.id
       WHERE r.id = ?`,
    )
    .get(harness.workerRoleId) as
    | { version: number; system_prompt: string; skills_json: string; allowed_tools_json: string }
    | null;
  if (row === null) throw new Error("no version row");
  return row;
}

describe("clobber CLI — roles edit", () => {
  it("--system-prompt-file replaces the prompt and bumps the version", async () => {
    const s = captureStreams();
    const file = join(harness.tmpDir, "prompt-file.md");
    writeFileSync(file, "you are a careful auditor\n");

    const before = readWorkerVersion();

    const code = await run({
      argv: ["roles", "edit", "worker", "--system-prompt-file", file],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out()).toContain("worker");

    const after = readWorkerVersion();
    expect(after.version).toBe(before.version + 1);
    expect(after.system_prompt).toBe("you are a careful auditor\n");
  });

  it("--system-prompt - reads from stdin", async () => {
    const s = captureStreams();
    const stdin = Readable.from(["stdin-prompt-content\n"]);

    const before = readWorkerVersion();

    const code = await run({
      argv: ["roles", "edit", "worker", "--system-prompt", "-"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
      stdin: stdin as unknown as NodeJS.ReadableStream,
    });
    expect(code).toBe(0);

    const after = readWorkerVersion();
    expect(after.version).toBe(before.version + 1);
    expect(after.system_prompt).toBe("stdin-prompt-content\n");
  });

  it("--allowed-tools replaces the tool set", async () => {
    const s = captureStreams();
    const before = readWorkerVersion();

    const code = await run({
      argv: ["roles", "edit", "worker", "--allowed-tools", "Read,Grep,Bash"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const after = readWorkerVersion();
    expect(after.version).toBe(before.version + 1);
    expect(JSON.parse(after.allowed_tools_json)).toEqual(["Read", "Grep", "Bash"]);
  });

  it("--add-skill is repeatable and appends new skills", async () => {
    const s = captureStreams();
    const skillA = join(harness.tmpDir, "skill-a.md");
    const skillB = join(harness.tmpDir, "skill-b.md");
    writeFileSync(skillA, "# A skill body");
    writeFileSync(skillB, "# B skill body");

    const before = readWorkerVersion();
    const beforeSkills = JSON.parse(before.skills_json) as Array<{ name: string }>;
    const beforeNames = beforeSkills.map((s) => s.name);

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

    const after = readWorkerVersion();
    expect(after.version).toBe(before.version + 1);
    const afterSkills = JSON.parse(after.skills_json) as Array<{
      name: string;
      body: string;
    }>;
    const afterNames = afterSkills.map((s) => s.name);
    expect(afterNames).toEqual([...beforeNames, "aaa", "bbb"]);
    const aaa = afterSkills.find((s) => s.name === "aaa");
    const bbb = afterSkills.find((s) => s.name === "bbb");
    expect(aaa?.body).toBe("# A skill body");
    expect(bbb?.body).toBe("# B skill body");
  });

  it("--remove-skill drops named skills from the current set", async () => {
    const s = captureStreams();

    const before = readWorkerVersion();
    const beforeSkills = JSON.parse(before.skills_json) as Array<{ name: string }>;
    const target = beforeSkills.find((s) => s.name === "aaa");
    expect(target).toBeDefined();

    const code = await run({
      argv: ["roles", "edit", "worker", "--remove-skill", "aaa"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const after = readWorkerVersion();
    expect(after.version).toBe(before.version + 1);
    const afterNames = (JSON.parse(after.skills_json) as Array<{ name: string }>).map(
      (s) => s.name,
    );
    expect(afterNames).not.toContain("aaa");
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
      version_id: string;
      version: number;
    };
    expect(parsed.role_id).toBe(harness.workerRoleId);
    expect(typeof parsed.version_id).toBe("string");
    expect(typeof parsed.version).toBe("number");
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
});
