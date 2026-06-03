import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoleBundle } from "@clobber/runtime";
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
import { ensureUpstreamRoleRepo } from "../src/role-repo.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #385 — flipping the seed default to commit-pins, plus the read sites that
// surface a version-row identity (GET /agent/roles views + operator
// /workspaces/:wid/roles) and the remaining auth-gated routes. The premise:
// when an upstream role repo is configured (production always sets it), seeding
// embodies from git — a seeded role carries a `current_commit`, not a
// `role_versions` row pointer.

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  roles: ReturnType<typeof createRoleStore>;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(repoDir: string | undefined): Harness {
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  const roles = createRoleStore(db);
  let pid = 9700;
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
    ...(repoDir === undefined ? {} : { roleRepoDir: repoDir }),
  });
  return { server, db, tokens, roles };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function roleRow(
  h: Harness,
  name: string,
  wsId: string,
): { id: string; branch: string | null; sha: string | null } {
  const row = h.db
    .prepare(
      `SELECT id, current_commit_branch AS branch, current_commit_sha AS sha
         FROM roles WHERE name = ? AND workspace_id = ?`,
    )
    .get(name, wsId) as
    | { id: string; branch: string | null; sha: string | null }
    | null;
  if (row === null) throw new Error(`role ${name} not seeded`);
  return row;
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

async function spawnToken(h: Harness, wsId: string, id: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: id, prompt: "boot", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn: ${res.body}`);
  return h.tokens.mint((res.json() as { session_id: string }).session_id);
}

let repo: RepoFixture;
let roleRepoDir: string;

beforeEach(() => {
  repo = makeRepoFixture("clobber-seed-flip-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-seed-flip-repo-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("#385 part 1 — seed default flips to commit-pins", () => {
  it("seeds roles pinned to their fork commit when a role repo is configured", async () => {
    const h = buildHarness(roleRepoDir);
    const wsId = await createWorkspace(h, repo.path);
    const upstream = ensureUpstreamRoleRepo(roleRepoDir);

    for (const name of ["manager", "worker"]) {
      const row = roleRow(h, name, wsId);
      const fork = upstream.forks.get(name)!;
      expect(row.branch).toBe(fork.branch);
      expect(row.sha).toBe(fork.sha);
    }

    await teardown(h);
  });

  it("seeds row-backed roles when no role repo is configured (fallback)", async () => {
    const h = buildHarness(undefined);
    const wsId = await createWorkspace(h, repo.path);

    const worker = roleRow(h, "worker", wsId);
    // After #491: current_version_id is dropped; roles still have version rows but no pointer.
    expect(worker.branch).toBeNull();
    expect(worker.sha).toBeNull();
    // Version row exists (for test fallback via latestForRole).
    const versionCount = (h.db.prepare("SELECT COUNT(*) n FROM role_versions WHERE role_id = ?").get(worker.id) as { n: number }).n;
    expect(versionCount).toBeGreaterThan(0);

    await teardown(h);
  });
});

describe("#385 part 3 — read views surface commit-pinned roles", () => {
  it("GET /agent/roles lists a commit-pinned role with its commit ref, not a version uuid", async () => {
    const h = buildHarness(roleRepoDir);
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleRow(h, "manager", wsId).id;
    const token = await spawnToken(h, wsId, managerId);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/roles",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      roles: Array<{
        name: string;
        current_version_id?: string;
        current_commit?: { branch: string; sha: string };
        version: number;
      }>;
    };
    const manager = body.roles.find((r) => r.name === "manager")!;
    expect(manager).toBeDefined();
    expect(manager.current_version_id).toBeUndefined();
    expect(manager.current_commit).toBeDefined();
    const upstream = ensureUpstreamRoleRepo(roleRepoDir);
    expect(manager.current_commit!.sha).toBe(upstream.forks.get("manager")!.sha);

    await teardown(h);
  });

  it("operator GET /workspaces/:wid/roles surfaces the commit ref on the role", async () => {
    const h = buildHarness(roleRepoDir);
    const wsId = await createWorkspace(h, repo.path);
    const upstream = ensureUpstreamRoleRepo(roleRepoDir);

    const res = await h.server.inject({ method: "GET", url: `/workspaces/${wsId}/roles` });
    expect(res.statusCode).toBe(200);
    const assignments = res.json() as Array<{
      role: { name: string; current_commit?: { branch: string; sha: string } };
    }>;
    const worker = assignments.find((a) => a.role.name === "worker")!;
    expect(worker.role.current_commit).toEqual({
      branch: upstream.forks.get("worker")!.branch,
      sha: upstream.forks.get("worker")!.sha,
    });

    await teardown(h);
  });
});

describe("#385 part 4 — authed routes stay commit-safe with the flip", () => {
  it("the operator triggers route edits a commit-pinned (seeded) manager", async () => {
    const h = buildHarness(roleRepoDir);
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleRow(h, "manager", wsId).id;

    const res = await h.server.inject({
      method: "PUT",
      url: `/workspaces/${wsId}/roles/${managerId}/triggers`,
      payload: { triggers: [{ kind: "webhook", path: "/wake" }] },
    });
    expect(res.statusCode).toBe(200);

    await teardown(h);
  });

  it("an agent CLI command authorizes for a commit-pinned (seeded) session", async () => {
    const h = buildHarness(roleRepoDir);
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleRow(h, "worker", wsId).id;
    const token = await spawnToken(h, wsId, workerId);

    // GET /agent/me runs through withAgentAuth → authorizeCommand, which resolves
    // the allow-list. A commit-pinned role must resolve through the cache, not 500.
    // This route's deps (agent.ts) did NOT carry roleEmbodiment before #385.
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // Sanity: the worker role really is commit-pinned here.
    expect(loadRoleBundle("worker")).not.toBeNull();

    await teardown(h);
  });
});
