import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
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
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runWithExit } from "../src/main.ts";

// #445 — CLI integration tests for `clobber prompt-modules` subcommands.
// The CLI calls /agent/me (requires real session) then workspace routes.
// Harness spawns a mock manager to get a real session token.

const MODULE_DIR = ".clobber/prompt-modules";
const MODULE_FILE = "prompt-module.json";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  baseUrl: string;
  repoPath: string;
  wsId: string;
  sessionToken: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

let harness: Harness;

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-pm-cli-repo-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");

  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pid = 9950;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pid += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };

  const app = createServer({
    db,
    store: createEventStore(db),
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
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

  // Create workspace
  const wsRes = await fetch(`${baseUrl}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "pm-cli-test", repo_path: repoPath }),
  });
  if (!wsRes.ok) throw new Error(`create workspace: ${await wsRes.text()}`);
  const wsId = ((await wsRes.json()) as { id: string }).id;

  // Spawn manager to get a real session token
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = ?")
    .get(wsId, "manager") as { id: string } | null;
  if (roleRow === null) throw new Error("manager role not seeded");
  const spawnRes = await fetch(`${baseUrl}/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: wsId, role_id: roleRow.id, prompt: "boot", label: "boot" }),
  });
  if (!spawnRes.ok) throw new Error(`spawn: ${await spawnRes.text()}`);
  const { session_id } = (await spawnRes.json()) as { session_id: string };
  const sessionToken = tokens.mint(session_id);

  harness = { app, db, tokens, baseUrl, repoPath, wsId, sessionToken };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
});

function cliEnv(): NodeJS.ProcessEnv {
  return {
    CLOBBER_API_BASE: harness.baseUrl,
    CLOBBER_SESSION_TOKEN: harness.sessionToken,
  };
}

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

function moduleFilePath(name: string): string {
  return join(harness.repoPath, MODULE_DIR, name, MODULE_FILE);
}

function writeWorkspaceModule(name: string, definition: Record<string, unknown>): void {
  const dir = join(harness.repoPath, MODULE_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MODULE_FILE), JSON.stringify(definition));
}

describe("clobber prompt-modules list", () => {
  it("lists shipped defaults", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "list"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("repo-sdlc");
    expect(out).toContain("shipped-default");
  });

  it("lists with --json", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "list", "--json"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as Array<{ name: string; source: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((e) => e.name === "repo-sdlc")).toBe(true);
  });
});

describe("clobber prompt-modules show", () => {
  it("shows a shipped default", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "show", "repo-sdlc"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("repo-sdlc");
    expect(out).toContain("static");
  });

  it("shows a dynamic module with provider info prominently", async () => {
    writeWorkspaceModule("my-exec-show", {
      kind: "dynamic",
      provider: { kind: "exec", command: "echo", args: ["hello"] },
    });
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "show", "my-exec-show"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("exec");
    expect(out).toContain("echo");
  });

  it("shows with --json", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "show", "repo-sdlc", "--json"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as { name: string; definition: { kind: string } };
    expect(parsed.name).toBe("repo-sdlc");
    expect(parsed.definition.kind).toBe("static");
  });

  it("exits non-zero for unknown module", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "show", "no-such-module"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).not.toBe(0);
  });
});

describe("clobber prompt-modules create", () => {
  it("creates a static module via --static-file", async () => {
    const tmpFile = join(harness.repoPath, "guide.md");
    writeFileSync(tmpFile, "# Guide\nsome content");
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "create", "guide-from-file", "--static-file", tmpFile],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(existsSync(moduleFilePath("guide-from-file"))).toBe(true);
    const out = s.out();
    expect(out).toContain("guide-from-file");
  });

  it("creates a dynamic exec module via --exec", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: [
        "prompt-modules",
        "create",
        "my-exec-create",
        "--exec",
        "echo hello",
      ],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(existsSync(moduleFilePath("my-exec-create"))).toBe(true);
  });

  it("creates a dynamic http module via --http", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: [
        "prompt-modules",
        "create",
        "my-http-create",
        "--http",
        "http://example.invalid/ctx",
      ],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(existsSync(moduleFilePath("my-http-create"))).toBe(true);
  });

  it("exits non-zero if workspace module already exists", async () => {
    writeWorkspaceModule("already-exists", { kind: "static", text: "here" });
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "create", "already-exists", "--static-file", join(harness.repoPath, "guide.md")],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).not.toBe(0);
  });
});

describe("clobber prompt-modules edit", () => {
  it("edits an existing workspace module", async () => {
    writeWorkspaceModule("edit-target", { kind: "static", text: "original" });
    const tmpFile = join(harness.repoPath, "new-content.md");
    writeFileSync(tmpFile, "updated content");
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "edit", "edit-target", "--static-file", tmpFile],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("edit-target");
  });

  it("forks a workspace shadow when editing a shipped default; prints shadow notice", async () => {
    const tmpFile = join(harness.repoPath, "new-sdlc.md");
    writeFileSync(tmpFile, "custom sdlc content");
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "edit", "repo-sdlc", "--static-file", tmpFile],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out.toLowerCase()).toContain("shadow");
    expect(existsSync(moduleFilePath("repo-sdlc"))).toBe(true);
  });

  it("exits non-zero for unknown module name", async () => {
    const tmpFile = join(harness.repoPath, "x.md");
    writeFileSync(tmpFile, "x");
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "edit", "totally-unknown", "--static-file", tmpFile],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).not.toBe(0);
  });
});

describe("clobber prompt-modules delete", () => {
  it("deletes a workspace module", async () => {
    writeWorkspaceModule("delete-me", { kind: "static", text: "bye" });
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "delete", "delete-me"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(existsSync(moduleFilePath("delete-me"))).toBe(false);
  });

  it("refuses to delete a pure shipped default", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "delete", "wisdom-pointer"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).not.toBe(0);
  });

  it("deletes with --force overriding ref-safety", async () => {
    writeWorkspaceModule("force-del-cli", { kind: "static", text: "x" });
    // Inject a ref into the manager's role_version
    const roleRow = harness.db
      .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = ?")
      .get(harness.wsId, "manager") as { id: string } | null;
    const latestVersion = roleRow === null ? null : (harness.db
      .prepare("SELECT id, seed_refs_json FROM role_versions WHERE role_id = ? ORDER BY version DESC LIMIT 1")
      .get(roleRow.id) as { id: string; seed_refs_json: string } | null);
    if (latestVersion !== null) {
      const refs = JSON.parse(latestVersion.seed_refs_json) as Array<{ name: string; enabled: boolean }>;
      refs.push({ name: "force-del-cli", enabled: true });
      harness.db
        .prepare("UPDATE role_versions SET seed_refs_json = ? WHERE id = ?")
        .run(JSON.stringify(refs), latestVersion.id);
    }
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["prompt-modules", "delete", "force-del-cli", "--force"],
      env: cliEnv(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(existsSync(moduleFilePath("force-del-cli"))).toBe(false);
  });
});
