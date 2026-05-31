import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
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
import { loadRoleContractAtCommit } from "../src/role-repo.ts";
import { listRoleBranches } from "../src/role-checkout-repo.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #216 PR3 — `checkout -b` (fork a role as a new git branch). The headline: a
// new workspace role pinned to a fresh `<new-name>` branch off the source tip,
// with NO role_versions row, the source ceiling inherited, and immediately
// checkout/commit-able. `roles fork` is a thin CLI alias for the same server
// operation, so the two produce an identical result.

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

let roleRepoDir: string;

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  const roles = createRoleStore(db);
  let pid = 9800;
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
    roles,
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
  return { server, db, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function roleRow(
  h: Harness,
  name: string,
  wsId: string,
): { id: string; workspace_id: string; current_version_id: string | null; current_commit_branch: string | null; current_commit_sha: string | null } {
  const row = h.db
    .prepare(
      "SELECT id, workspace_id, current_version_id, current_commit_branch, current_commit_sha FROM roles WHERE name = ? AND workspace_id = ?",
    )
    .get(name, wsId) as
    | { id: string; workspace_id: string; current_version_id: string | null; current_commit_branch: string | null; current_commit_sha: string | null }
    | null;
  if (row === null) throw new Error(`role ${name} not present`);
  return row;
}

function versionRowCount(h: Harness, id: string): number {
  return (
    h.db.prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?").get(id) as {
      n: number;
    }
  ).n;
}

function ceilingOf(h: Harness, wsId: string, roleId: string): number | null {
  const row = h.db
    .prepare("SELECT max_concurrent AS m FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?")
    .get(wsId, roleId) as { m: number } | null;
  return row === null ? null : row.m;
}

function cloneDirFor(wsId: string): string {
  return join(dirname(roleRepoDir), "role-repos", wsId);
}

async function createWorkspace(h: Harness, repoPath: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: `ws-${repoPath}`, repo_path: repoPath },
  });
  if (res.statusCode !== 201) throw new Error(`create ws: ${res.body}`);
  return (res.json() as { id: string }).id;
}

async function spawnManager(h: Harness, wsId: string): Promise<string> {
  const managerId = roleRow(h, "manager", wsId).id;
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: managerId, prompt: "boot", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn: ${res.body}`);
  return h.tokens.mint((res.json() as { session_id: string }).session_id);
}

interface ForkResponse {
  readonly role_id: string;
  readonly branch: string;
  readonly sha: string;
}

async function checkoutB(
  h: Harness,
  token: string,
  source: string,
  newName: string,
): Promise<ForkResponse> {
  const res = await h.server.inject({
    method: "POST",
    url: `/agent/roles/${encodeURIComponent(source)}/fork`,
    headers: { authorization: `Bearer ${token}` },
    payload: { new_name: newName },
  });
  if (res.statusCode !== 201) throw new Error(`checkout -b ${newName}: ${res.statusCode} ${res.body}`);
  return res.json() as ForkResponse;
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-checkout-b-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-checkout-b-repo-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("#216 PR3 — checkout -b (fork via git)", () => {
  it("creates a workspace role on a fresh branch, commit-pinned, NO version row, ceiling inherited", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleRow(h, "worker", wsId).id;
    const token = await spawnManager(h, wsId);

    // Give the source a non-default ceiling so inheritance is observable.
    const setCeiling = await h.server.inject({
      method: "PUT",
      url: `/agent/roles/${workerId}/ceiling`,
      headers: { authorization: `Bearer ${token}` },
      payload: { max_concurrent: 3 },
    });
    expect(setCeiling.statusCode).toBe(200);

    const result = await checkoutB(h, token, "worker", "my-worker");

    const created = roleRow(h, "my-worker", wsId);
    expect(result.role_id).toBe(created.id);
    expect(created.workspace_id).toBe(wsId);

    // Commit-pinned to a fresh `my-worker` branch — NOT a role_versions row.
    expect(created.current_version_id).toBeNull();
    expect(created.current_commit_branch).toBe("my-worker");
    expect(created.current_commit_sha).toBe(result.sha);
    expect(result.branch).toBe("my-worker");
    expect(versionRowCount(h, created.id)).toBe(0);

    // The branch exists in the workspace clone and carries the source content.
    const branches = listRoleBranches(cloneDirFor(wsId));
    expect(branches).toContain("my-worker");
    const forkContract = loadRoleContractAtCommit(cloneDirFor(wsId), result.sha);
    const sourceContract = loadRoleContractAtCommit(
      cloneDirFor(wsId),
      roleRow(h, "worker", wsId).current_commit_sha!,
    );
    expect(forkContract.systemPrompt).toBe(sourceContract.systemPrompt);

    // Ceiling inherited from the source.
    expect(ceilingOf(h, wsId, created.id)).toBe(3);

    await teardown(h);
  });

  it("the new role is immediately checkout → edit → commit-able", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const token = await spawnManager(h, wsId);

    const fork = await checkoutB(h, token, "worker", "my-worker");

    const co = await h.server.inject({
      method: "POST",
      url: "/agent/roles/my-worker/checkout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(co.statusCode, co.body).toBe(200);
    const checkoutDir = (co.json() as { checkout_dir: string }).checkout_dir;

    const promptPath = join(checkoutDir, "system-prompt.md");
    const edited = `${readFileSync(promptPath, "utf8")}\nEDIT: my-worker tuning.\n`;
    writeFileSync(promptPath, edited);

    const commit = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "tune my-worker" },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const committed = commit.json() as { sha: string };

    // Pin advanced past the fork point; still no version row.
    expect(committed.sha).not.toBe(fork.sha);
    const after = roleRow(h, "my-worker", wsId);
    expect(after.current_commit_sha).toBe(committed.sha);
    expect(after.current_version_id).toBeNull();
    expect(versionRowCount(h, after.id)).toBe(0);

    const contract = loadRoleContractAtCommit(cloneDirFor(wsId), committed.sha);
    expect(contract.systemPrompt).toBe(edited);

    await teardown(h);
  });

  it("refuses a name that collides with an existing role (409) and a non-slug name (400)", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const token = await spawnManager(h, wsId);

    const dup = await h.server.inject({
      method: "POST",
      url: "/agent/roles/worker/fork",
      headers: { authorization: `Bearer ${token}` },
      payload: { new_name: "manager" },
    });
    expect(dup.statusCode).toBe(409);

    for (const bad of ["has space", "weird/slash", "dot.dot"]) {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/roles/worker/fork",
        headers: { authorization: `Bearer ${token}` },
        payload: { new_name: bad },
      });
      expect(res.statusCode).toBe(400);
    }

    await teardown(h);
  });
});
