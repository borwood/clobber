import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { run } from "../src/main.ts";

let app: ReturnType<typeof createServer>;
let db: ReturnType<typeof createDatabase>;
let baseUrl: string;
let token: string;
let repoPath: string;
let briefingDir: string;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-spawn-brief-cli-"));
  briefingDir = mkdtempSync(join(tmpdir(), "clobber-brief-input-"));
  writeFileSync(join(briefingDir, "seed-todos.json"), '[{"content":"x","status":"pending","activeForm":"y"}]');
  writeFileSync(join(briefingDir, "assignment.md"), "# Goal\nship #82.\n");
  mkdirSync(join(briefingDir, "context"), { recursive: true });
  writeFileSync(join(briefingDir, "context", "conventions.md"), "squash merges only");

  db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const managerRole = roles.create({ name: "manager", persistent: true });
  workspaceRoles.setCeiling(ws.id, managerRole.id, 5);
  const wbRole = roles.create({ name: "worker", persistent: false });
  workspaceRoles.setCeiling(ws.id, wbRole.id, 3);

  const spawner: AgentSpawner = (req): SpawnedAgentInfo => ({
    sessionId: req.sessionId!,
    pid: 7777,
    exited: new Promise<number | null>(() => {}),
    stdin: makeStdin(),
    kill: () => {},
  });

  app = createServer({
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
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) {
    throw new Error(`boot failed: ${bootRes.body}`);
  }
  const bootBody = bootRes.json() as { session_id: string };
  token = tokens.mint(bootBody.session_id);
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(briefingDir, { recursive: true, force: true });
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

describe("clobber CLI — spawn --briefing-dir / --briefing", () => {
  it("packs --briefing-dir contents (recursive) and the server writes them to the worker's desk", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "spawn",
        "worker",
        "--prompt",
        "ship #82",
        "--label",
        "issue-82",
        "--briefing-dir",
        briefingDir,
      ],
      env: { CLOBBER_API_BASE: baseUrl, CLOBBER_SESSION_TOKEN: token },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as { agent_id: string };
    const desk = join(repoPath, ".clobber", "agents", parsed.agent_id, "desk");
    expect(readFileSync(join(desk, "seed-todos.json"), "utf8")).toContain("activeForm");
    expect(readFileSync(join(desk, "assignment.md"), "utf8")).toMatch(/ship #82/);
    expect(readFileSync(join(desk, "context", "conventions.md"), "utf8")).toBe(
      "squash merges only",
    );
  });

  it("packs an individual --briefing name:path file", async () => {
    const onefile = join(tmpdir(), `clobber-onefile-${Date.now()}.md`);
    writeFileSync(onefile, "single brief");
    try {
      const s = captureStreams();
      const code = await run({
        argv: [
          "spawn",
          "worker",
          "--prompt",
          "p",
          "--label",
          "onefile",
          "--briefing",
          `notes.md:${onefile}`,
        ],
        env: { CLOBBER_API_BASE: baseUrl, CLOBBER_SESSION_TOKEN: token },
        stdout: s.stdout,
        stderr: s.stderr,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(s.out()) as { agent_id: string };
      const desk = join(repoPath, ".clobber", "agents", parsed.agent_id, "desk");
      expect(readFileSync(join(desk, "notes.md"), "utf8")).toBe("single brief");
    } finally {
      rmSync(onefile, { force: true });
    }
  });

  it("does not create the desk directory when no briefing flags are passed", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["spawn", "worker", "--prompt", "p", "--label", "no-brief"],
      env: { CLOBBER_API_BASE: baseUrl, CLOBBER_SESSION_TOKEN: token },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as { agent_id: string };
    const desk = join(repoPath, ".clobber", "agents", parsed.agent_id, "desk");
    expect(existsSync(desk)).toBe(false);
  });

  it("exits 2 when --briefing has no name:path separator", async () => {
    const s = captureStreams();
    const code = await run({
      argv: [
        "spawn",
        "worker",
        "--prompt",
        "p",
        "--label",
        "bad",
        "--briefing",
        "missing-colon",
      ],
      env: { CLOBBER_API_BASE: baseUrl, CLOBBER_SESSION_TOKEN: token },
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--briefing/);
  });
});
