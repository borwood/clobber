import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { DRIFT_STUB_API_BASE } from "@clobber/server/_drift-stub.ts";
import { run } from "../src/main.ts";

// The real dogfood example lives at the repo root; this test file is
// packages/cli/tests/. Its repo_path is a documented placeholder, so the test
// rewrites it to a valid fixture before loading — everything else is verbatim.
const EXAMPLE_DIR = join(import.meta.dir, "../../../examples/clobber-on-clobber");

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  repoPath: string;
  configDir: string;
  roleRepoDir: string;
}

let harness: Harness;

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-ws-create-repo-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-ws-create-rolerepo-"));

  const db = createDatabase(":memory:");
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
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => {
      throw new Error("spawn not expected in loader test");
    },
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

  // Build a loadable config dir from the real example, with a valid repo_path.
  const configDir = mkdtempSync(join(tmpdir(), "clobber-ws-create-config-"));
  const exampleConfig = JSON.parse(
    readFileSync(join(EXAMPLE_DIR, "workspace.config.json"), "utf8"),
  ) as Record<string, unknown>;
  exampleConfig["repo_path"] = repoPath;
  writeFileSync(
    join(configDir, "workspace.config.json"),
    JSON.stringify(exampleConfig, null, 2),
  );
  writeFileSync(
    join(configDir, "manager-triggers.json"),
    readFileSync(join(EXAMPLE_DIR, "manager-triggers.json"), "utf8"),
  );

  harness = { app, db, baseUrl, repoPath, configDir, roleRepoDir };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
  rmSync(harness.configDir, { recursive: true, force: true });
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

function env(): NodeJS.ProcessEnv {
  // Operator routes ignore the bearer, but readEnv still requires both vars.
  return { CLOBBER_API_BASE: harness.baseUrl, CLOBBER_SESSION_TOKEN: "operator" };
}

// #414 — the loader applies manager triggers through the git pin (no version
// row); read them back from the contract at the manager's commit.
function managerTriggers(): { commitPinned: boolean; triggers: readonly unknown[] } {
  const ws = harness.db
    .prepare("SELECT id FROM workspaces WHERE name = ?")
    .get("clobber-on-clobber") as { id: string };
  const role = harness.db
    .prepare(
      "SELECT current_commit_sha AS sha FROM roles WHERE name = ? AND workspace_id = ?",
    )
    .get("manager", ws.id) as { sha: string | null };
  if (role.sha === null) throw new Error("manager is not commit-pinned");
  const clone = join(dirname(harness.roleRepoDir), "role-repos", ws.id);
  const dir = existsSync(join(clone, ".git")) ? clone : harness.roleRepoDir;
  return {
    commitPinned: true, // After #491: commit-pinned is the only state.
    triggers: loadRoleContractAtCommit(dir, role.sha).triggers,
  };
}

describe("clobber CLI — workspace create --config (#181)", () => {
  it("creates the workspace and applies manager triggers in one command", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["workspace", "create", "--config", harness.configDir],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    // Seam 1: workspace created from workspace.config.json.
    const ws = harness.db
      .prepare("SELECT id FROM workspaces WHERE name = ?")
      .get("clobber-on-clobber") as { id: string } | null;
    expect(ws).not.toBeNull();

    // Seam 2: manager-triggers.json applied onto the manager role through the git
    // pin — the role stays commit-pinned (no demotion to a version row).
    const after = managerTriggers();
    expect(after.commitPinned).toBe(true);
    expect(after.triggers).toEqual(
      expect.arrayContaining([
        { kind: "workspace-open", wake_program: "idle" },
        { kind: "cron", expr: "0 9 * * *" },
        { kind: "worker-done" },
        { kind: "session-ended" },
      ]),
    );
    expect(after.triggers).toHaveLength(4);
  });
});
