import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { git, readTreeAtCommit } from "../src/role-git.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #401 step-1 — full-flow integration for the upstream read verbs:
// roles fetch / roles diff <role> @{upstream} / roles log <role> @{upstream}..
// Seeds a workspace clone with the upstream ahead by K commits; asserts that:
// - fetch refreshes the remote-tracking refs
// - diff shows line-level hunks (+/- lines in the content that changed upstream)
// - log lists the K commits on upstream not yet in local
// - a workspace-invented role (forked from manager) resolves the correct upstream
// - a role with no engine ancestor returns 422, never a silent wrong-target diff

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  wsId: string;
  managerToken: string;
  roleRepoDir: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

let harness: Harness;

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-upstream-diff-repo-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-upstream-diff-role-repo-"));

  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pid = 9900;
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

  const server = createServer({
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
    roleRepoDir,
  });

  // Create workspace → roles are pinned to the current upstream sha (OLD sha).
  const wsRes = await server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "upstream-diff-ws", repo_path: repoPath },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  // Spawn a manager session to get a token.
  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  if (managerRow === null) throw new Error("manager seed missing");

  const bootRes = await server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  // Advance the upstream by 2 commits on manager-default AFTER workspace creation.
  // The workspace role pins are at OLD sha; upstream will be ahead.
  advanceUpstreamManagerDefault(roleRepoDir, 2);

  harness = { server, db, tokens, wsId: ws.id, managerToken, roleRepoDir };
});

afterAll(async () => {
  await harness.server.close();
  harness.db.close();
  rmSync(harness.roleRepoDir, { recursive: true, force: true });
});

// Add K commits to manager-default in the upstream repo, simulating engine updates.
function advanceUpstreamManagerDefault(roleRepoDir: string, k: number): void {
  git(roleRepoDir, "checkout", "-q", "manager-default");
  for (let i = 1; i <= k; i++) {
    const sentinel = `# UPSTREAM-UPDATE-${i}`;
    const tree = readTreeAtCommit(roleRepoDir, "manager-default");
    const promptContent = tree.get("system-prompt.md") ?? "";
    writeFileSync(join(roleRepoDir, "system-prompt.md"), `${promptContent}\n${sentinel}\n`);
    git(roleRepoDir, "add", "-A");
    git(
      roleRepoDir,
      "-c", "user.email=clobber@local",
      "-c", "user.name=clobber",
      "-c", "commit.gpgsign=false",
      "commit", "-q", "-m", `upstream update ${i}`,
    );
  }
  git(roleRepoDir, "checkout", "-q", "base");
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("roles upstream read verbs (#401 step-1)", () => {
  it("POST /agent/roles/fetch creates clone and fetches upstream remote", async () => {
    const res = await harness.server.inject({
      method: "POST",
      url: "/agent/roles/fetch",
      headers: auth(harness.managerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { fetched: boolean };
    expect(body.fetched).toBe(true);
  });

  it("GET /agent/roles/manager/upstream/diff returns line-level hunks for engine-derived role", async () => {
    const res = await harness.server.inject({
      method: "GET",
      url: "/agent/roles/manager/upstream/diff",
      headers: auth(harness.managerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { diff: string };
    // The diff must contain content hunks (added lines starting with '+')
    expect(body.diff).toMatch(/^\+[^+]/m);
    // Must show the upstream sentinel content we added
    expect(body.diff).toContain("+# UPSTREAM-UPDATE-1");
    expect(body.diff).toContain("+# UPSTREAM-UPDATE-2");
  });

  it("GET /agent/roles/manager/upstream/log lists commits in upstream not in local", async () => {
    const res = await harness.server.inject({
      method: "GET",
      url: "/agent/roles/manager/upstream/log",
      headers: auth(harness.managerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { log: string };
    // K=2 commits should be listed
    const lines = body.log.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes("upstream update 1"))).toBe(true);
    expect(lines.some((l) => l.includes("upstream update 2"))).toBe(true);
  });

  it("workspace-invented role (forked from manager) resolves upstream/manager-default", async () => {
    // Fork manager into a workspace-invented role
    const forkRes = await harness.server.inject({
      method: "POST",
      url: "/agent/roles/manager/fork",
      headers: auth(harness.managerToken),
      payload: { new_name: "my-forked-role" },
    });
    expect(forkRes.statusCode, forkRes.body).toBe(201);

    // The forked role was created off manager's OLD pin sha. Diffing vs upstream
    // should also show upstream changes (same upstream/manager-default target).
    const diffRes = await harness.server.inject({
      method: "GET",
      url: "/agent/roles/my-forked-role/upstream/diff",
      headers: auth(harness.managerToken),
    });
    expect(diffRes.statusCode, diffRes.body).toBe(200);
    const body = diffRes.json() as { diff: string };
    // Must show upstream sentinel content — same upstream default resolved
    expect(body.diff).toContain("+# UPSTREAM-UPDATE-1");
  });

  it("role not found returns 404", async () => {
    const res = await harness.server.inject({
      method: "GET",
      url: "/agent/roles/nonexistent-role/upstream/diff",
      headers: auth(harness.managerToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("role with no commit pin returns 422 with clean error, never a silent wrong-target diff", async () => {
    // Create a bare role with no commit pin (should be impossible in production
    // after #491, but we synthesize it to test the guard).
    harness.db
      .prepare(
        "INSERT INTO roles (id, name, persistent, workspace_id, created_at) VALUES (?, ?, 0, ?, ?)",
      )
      .run("a0a0a0a0-a0a0-4a0a-a0a0-a0a0a0a0a001", "no-pin-role", harness.wsId, Date.now());

    const res = await harness.server.inject({
      method: "GET",
      url: "/agent/roles/no-pin-role/upstream/diff",
      headers: auth(harness.managerToken),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string };
    expect(body.error).toContain("no commit pin");
  });
});
