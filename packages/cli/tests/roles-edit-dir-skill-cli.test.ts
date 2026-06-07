import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
import { run } from "../src/main.ts";

// #450 — --add-skill name=DIR reads a skill directory: SKILL.md becomes
// the body and all other immediate files become companion entries in skill.files.

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  workspaceId: string;
  repoPath: string;
  roleRepoDir: string;
  tmpDir: string;
}

let h: Harness;

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-edit-dir-repo-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-edit-dir-roles-"));
  const tmpDir = mkdtempSync(join(tmpdir(), "clobber-edit-dir-files-"));
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pid = 9600;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pid += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const s = new PassThrough();
    s.resume();
    return { sessionId: req.sessionId, pid, exited: new Promise(() => {}), stdin: s, kill: () => {} };
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
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    roleRepoDir,
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");

  const wsRes = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "ws", repo_path: repoPath } });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const wsId = (wsRes.json() as { id: string }).id;

  const managerRow = db.prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?").get("manager", wsId) as { id: string } | null;
  if (managerRow === null) throw new Error("manager role not seeded");

  const bootRes = await app.inject({ method: "POST", url: "/spawn", payload: { workspace_id: wsId, role_id: managerRow.id, prompt: "boot", label: "boot" } });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const managerToken = tokens.mint((bootRes.json() as { session_id: string }).session_id);

  h = { app, db, baseUrl: `http://127.0.0.1:${addr.port}`, managerToken, workspaceId: wsId, repoPath, roleRepoDir, tmpDir };
});

afterAll(async () => {
  await h.app.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
  rmSync(h.roleRepoDir, { recursive: true, force: true });
  rmSync(h.tmpDir, { recursive: true, force: true });
});

function envFor(token: string): NodeJS.ProcessEnv {
  return { CLOBBER_API_BASE: h.baseUrl, CLOBBER_SESSION_TOKEN: token };
}

function workerContract() {
  const row = h.db.prepare("SELECT current_commit_sha FROM roles WHERE name = ? AND workspace_id = ?").get("worker", h.workspaceId) as { current_commit_sha: string } | null;
  if (row === null) throw new Error("worker role not found");
  const clone = join(dirname(h.roleRepoDir), "role-repos", h.workspaceId);
  const dir = existsSync(join(clone, ".git")) ? clone : h.roleRepoDir;
  return loadRoleContractAtCommit(dir, row.current_commit_sha);
}

describe("--add-skill name=DIR (#450)", () => {
  it("nested companions: files under subdirs are collected with relative paths (#517)", async () => {
    const skillDir = join(h.tmpDir, "nested-skill-dir");
    mkdirSync(skillDir);
    mkdirSync(join(skillDir, "sub"));
    writeFileSync(join(skillDir, "SKILL.md"), "# NESTED SKILL");
    writeFileSync(join(skillDir, "top.md"), "top-level companion");
    writeFileSync(join(skillDir, "sub", "deep.md"), "nested companion");

    const s = new PassThrough();
    const code = await run({
      argv: ["roles", "edit", "worker", "--add-skill", `nested-skill=${skillDir}`],
      env: envFor(h.managerToken),
      stdout: s,
      stderr: s,
    });
    expect(code).toBe(0);

    const contract = workerContract();
    const skill = contract.skills.find((sk) => sk.name === "nested-skill");
    expect(skill?.body).toBe("# NESTED SKILL");
    expect(skill?.files?.["top.md"]).toBe("top-level companion");
    expect(skill?.files?.["sub/deep.md"]).toBe("nested companion");
  });

  it("reads SKILL.md as body and companion files as skill.files", async () => {
    const skillDir = join(h.tmpDir, "my-skill-dir");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# MY SKILL\nBody here.");
    writeFileSync(join(skillDir, "context.md"), "companion context");
    writeFileSync(join(skillDir, "runbook.md"), "companion runbook");

    const s = new PassThrough();
    const code = await run({
      argv: ["roles", "edit", "worker", "--add-skill", `my-dir-skill=${skillDir}`],
      env: envFor(h.managerToken),
      stdout: s,
      stderr: s,
    });
    expect(code).toBe(0);

    const contract = workerContract();
    const skill = contract.skills.find((sk) => sk.name === "my-dir-skill");
    expect(skill?.body).toBe("# MY SKILL\nBody here.");
    expect(skill?.files).toEqual({ "context.md": "companion context", "runbook.md": "companion runbook" });
  });
});
