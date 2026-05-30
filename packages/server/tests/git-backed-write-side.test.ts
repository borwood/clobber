import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoleBundle } from "@clobber/runtime";
import type { ManagerSkillPolicy, RoleSkill } from "@clobber/shared";
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
import { createRoleContentCache } from "../src/role-content-cache.ts";
import { resolveCurrentRoleVersion } from "../src/resolve-role-content.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #361 — the git-backed WRITE-SIDE machinery (Option A), exercised against a
// commit-pinned role. The default-seeding flip is deferred (a tracked follow-up
// that also rewires the GET /agent/roles views + web role panel); this slice
// proves the additive, zero-regression half: a role pinned to a commit (#349)
//  1. resolves its current content from the materialized cache as a version view,
//  2. passes the per-command auth gate (which read a `role_versions` row before),
//  3. and is mutated by edit / fork / self-skills — sourcing content from the
//     cache, writing a row, and demoting the role to row-backed.

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

function workerCliAllowList(): readonly string[] {
  const loaded = loadRoleBundle("worker");
  if (loaded === null) throw new Error("no shipped worker role");
  return [...loaded.manifest.allowedCliCommands];
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
  return { server, db, tokens, roles };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function roleId(h: Harness, name: string, wsId: string): string {
  const row = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get(name, wsId) as { id: string } | null;
  if (row === null) throw new Error(`role ${name} not seeded`);
  return row.id;
}

// Flip a seeded (row-backed) role to git-backed by pinning its fork commit, the
// way production will once the seeding flip lands. Returns the pinned role.
function pinToFork(h: Harness, id: string, name: string) {
  const repo = ensureUpstreamRoleRepo(roleRepoDir);
  const fork = repo.forks.get(name);
  if (fork === undefined) throw new Error(`no fork branch for ${name}`);
  h.roles.pinCommit(id, { branch: fork.branch, sha: fork.sha });
  return h.roles.get(id)!;
}

function pinState(
  h: Harness,
  id: string,
): { branch: string | null; sha: string | null; versionId: string | null } {
  return h.db
    .prepare(
      "SELECT current_commit_branch AS branch, current_commit_sha AS sha, current_version_id AS versionId FROM roles WHERE id = ?",
    )
    .get(id) as { branch: string | null; sha: string | null; versionId: string | null };
}

function currentSkills(h: Harness, id: string): RoleSkill[] {
  const row = h.db
    .prepare(
      `SELECT v.skills_json AS j FROM role_versions v
       JOIN roles r ON r.current_version_id = v.id WHERE r.id = ?`,
    )
    .get(id) as { j: string } | null;
  if (row === null) throw new Error(`no current version row for ${id}`);
  return JSON.parse(row.j) as RoleSkill[];
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

function writeCatalogSkill(repoPath: string, name: string, body: string): void {
  const dir = join(repoPath, ".clobber", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-git-write-side-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-git-write-side-repo-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("#361 resolveCurrentRoleVersion read-view", () => {
  it("returns a commit-pinned role's content from the materialized cache", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const worker = pinToFork(h, roleId(h, "worker", wsId), "worker");

    const cache = createRoleContentCache(h.db);
    const view = resolveCurrentRoleVersion(worker, {
      roleVersions: createRoleVersionStore(h.db),
      roleContentCache: cache,
      roleRepoDir,
    });
    if (view === null) throw new Error("expected a view for a commit-pinned role");

    expect(JSON.parse(view.allowed_cli_commands_json)).toEqual(workerCliAllowList());
    expect(Array.isArray(JSON.parse(view.skills_json))).toBe(true);
    expect(view.system_prompt.length).toBeGreaterThan(0);

    await teardown(h);
  });

  it("returns the persisted row for a row-backed role", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const worker = h.roles.get(roleId(h, "worker", wsId))!;

    const view = resolveCurrentRoleVersion(worker, {
      roleVersions: createRoleVersionStore(h.db),
      roleContentCache: createRoleContentCache(h.db),
      roleRepoDir,
    });
    expect(view!.id).toBe(worker.current_version_id!);

    await teardown(h);
  });
});

describe("#361 git-backed write-side through the routes", () => {
  it("the per-command auth gate accepts a commit-pinned role", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, managerId, "manager");

    // GET /agent/self-skills runs through authorizeCommand, which read a
    // `role_versions` row before #361 → would 500 for a commit-pinned role.
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    await teardown(h);
  });

  it("self-skills grant against a commit-pinned manager demotes it to row-backed", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, managerId, "manager");
    expect(pinState(h, managerId).versionId).toBeNull();

    writeCatalogSkill(repo.path, "clobber-pm", "# /clobber-pm\nbody");
    const policy: ManagerSkillPolicy = {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    };
    const polRes = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}`,
      payload: { manager_skill_policy: policy },
    });
    expect(polRes.statusCode).toBe(200);

    const grant = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "clobber-pm" },
    });
    expect(grant.statusCode).toBe(200);

    const pin = pinState(h, managerId);
    expect(pin.sha).toBeNull();
    expect(pin.branch).toBeNull();
    expect(pin.versionId).not.toBeNull();
    expect(currentSkills(h, managerId).map((s) => s.name)).toContain("clobber-pm");

    await teardown(h);
  });

  it("forks a commit-pinned source: row-backed fork with the source's tools, source unchanged", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, workerId, "worker");

    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${workerId}/fork`,
      headers: { authorization: `Bearer ${token}` },
      payload: { new_name: "worker-fork" },
    });
    expect(res.statusCode).toBe(201);
    const fork = res.json() as { role_id: string; version: number };
    expect(fork.version).toBe(1);

    const toolsRow = h.db
      .prepare(
        `SELECT v.allowed_tools_json AS j FROM role_versions v
         JOIN roles r ON r.current_version_id = v.id WHERE r.id = ?`,
      )
      .get(fork.role_id) as { j: string };
    expect(Array.isArray(JSON.parse(toolsRow.j))).toBe(true);

    // The forked source stays git-backed — forking reads it, never demotes it.
    expect(pinState(h, workerId).sha).not.toBeNull();
    expect(pinState(h, workerId).versionId).toBeNull();

    await teardown(h);
  });

  it("edits a commit-pinned role, demoting it and applying the patch", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, workerId, "worker");

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${workerId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: "edited worker prompt" },
    });
    expect(res.statusCode).toBe(200);

    const pin = pinState(h, workerId);
    expect(pin.sha).toBeNull();
    expect(pin.versionId).not.toBeNull();

    const promptRow = h.db
      .prepare(
        `SELECT v.system_prompt AS p FROM role_versions v
         JOIN roles r ON r.current_version_id = v.id WHERE r.id = ?`,
      )
      .get(workerId) as { p: string };
    expect(promptRow.p).toBe("edited worker prompt");

    await teardown(h);
  });
});
