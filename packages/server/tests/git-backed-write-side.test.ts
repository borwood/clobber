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
import { dirname } from "node:path";
import { ensureUpstreamRoleRepo, loadRoleContractAtCommit } from "../src/role-repo.ts";
import { createRoleContentCache } from "../src/role-content-cache.ts";
import { resolveCurrentRoleVersion } from "../src/resolve-role-content.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #361/#414 — the git-backed WRITE-SIDE machinery, exercised against a
// commit-pinned role. (The default-seeding flip + view/web rewire landed in
// #385; with a repo configured, seeding now pins commits — see git-seed-flip.)
// This slice proves the write-side half: a role pinned to a commit (#349)
//  1. resolves its current content from the materialized cache as a version view,
//  2. passes the per-command auth gate (which read a `role_versions` row before),
//  3. and is mutated by edit / fork / self-skills / operator-triggers — sourcing
//     content from the cache and ADVANCING THE COMMIT PIN (no new version row, no
//     demotion). #414 retired the version-row write path: every one-shot patch
//     now compiles to a commit on the role branch, so the no-demotion guarantee
//     (#396) holds across all three front-doors.

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

// `withRepo` defaults true: the upstream repo is configured, so seeding pins
// commits (#385) and the auth gate can resolve them. Pass `{ withRepo: false }`
// for the no-repo fallback, where seeding stays row-backed.
function buildHarness({ withRepo = true }: { withRepo?: boolean } = {}): Harness {
  const repoDir = withRepo ? roleRepoDir : undefined;
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
    ...(repoDir === undefined ? {} : { roleRepoDir: repoDir }),
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

// Re-pin a seeded role to its fork commit. With a repo configured the seed is
// already commit-pinned (#385), so this is idempotent; it stays explicit so the
// tests below read clearly against a known commit pin. Returns the pinned role.
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

function versionRowCount(h: Harness, id: string): number {
  return (
    h.db
      .prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?")
      .get(id) as { n: number }
  ).n;
}

// Read the committed role contract for a workspace role at a sha, from its
// per-workspace clone (the same clone the write-side commits onto). The clone is
// provisioned lazily on the first route call, so the post-mutation `after` reads
// resolve here.
function contractAt(wsId: string, sha: string) {
  const cloneDir = join(dirname(roleRepoDir), "role-repos", wsId);
  return loadRoleContractAtCommit(cloneDir, sha);
}

// The pre-mutation baseline resolves from the shared upstream repo: a seeded role
// is pinned to its upstream fork tip, and the clone (which copies every reachable
// object) does not exist until the first mutating route call materializes it.
function upstreamContractAt(sha: string) {
  return loadRoleContractAtCommit(roleRepoDir, sha);
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
    // No repo configured → seeding stays row-backed (the #385 fallback).
    const h = buildHarness({ withRepo: false });
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

  it("self-skills grant advances the manager's commit pin (no demotion), preserving every other field", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, managerId, "manager");
    const beforeSha = pinState(h, managerId).sha!;
    const before = upstreamContractAt(beforeSha);

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

    // No demotion: the pin advances, no version row is written.
    const pin = pinState(h, managerId);
    expect(pin.sha).not.toBeNull();
    expect(pin.branch).toBe("manager");
    expect(pin.versionId).toBeNull();
    expect(pin.sha).not.toBe(beforeSha);
    expect(versionRowCount(h, managerId)).toBe(0);

    // The grant applied AND every other field survived the snapshot→commit round-trip.
    const after = contractAt(wsId, pin.sha!);
    expect(after.skills.map((s) => s.name)).toContain("clobber-pm");
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.framing).toBe(before.framing);
    expect(after.allowedTools).toEqual(before.allowedTools);
    expect(after.allowedCliCommands).toEqual(before.allowedCliCommands);
    expect(after.triggers).toEqual(before.triggers);
    expect(after.seedRefs).toEqual(before.seedRefs);
    expect(after.wakePrograms).toEqual(before.wakePrograms);
    expect(after.hooks).toBe(before.hooks);
    expect(after.defaultWakeProgram).toBe(before.defaultWakeProgram);

    await teardown(h);
  });

  it("forks a commit-pinned source: commit-pinned fork with the source's tools, source unchanged", async () => {
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
    const fork = res.json() as { role_id: string; branch: string; sha: string };
    expect(fork.branch).toBe("worker-fork");

    // The fork is commit-pinned to its own branch — NOT a new role_versions row.
    const forkPin = pinState(h, fork.role_id);
    expect(forkPin.branch).toBe("worker-fork");
    expect(forkPin.sha).toBe(fork.sha);
    expect(forkPin.versionId).toBeNull();
    const forkVersionRows = (
      h.db.prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?").get(fork.role_id) as {
        n: number;
      }
    ).n;
    expect(forkVersionRows).toBe(0);

    // The fork's commit carries the source's tools.
    const cloneDir = join(dirname(roleRepoDir), "role-repos", wsId);
    const contract = loadRoleContractAtCommit(cloneDir, fork.sha);
    expect(Array.isArray(contract.allowedTools)).toBe(true);

    // The forked source stays git-backed — forking reads it, never demotes it.
    expect(pinState(h, workerId).sha).not.toBeNull();
    expect(pinState(h, workerId).versionId).toBeNull();

    await teardown(h);
  });

  it("edit advances a commit-pinned role's pin (no demotion), applying the patch and preserving every other field", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, workerId, "worker");
    const beforeSha = pinState(h, workerId).sha!;
    const before = upstreamContractAt(beforeSha);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${workerId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: "edited worker prompt" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { branch: string; sha: string; no_new_version: boolean };
    expect(body.no_new_version).toBe(true);
    expect(body.branch).toBe("worker");

    // No demotion: the pin advances to the returned sha, no version row written.
    const pin = pinState(h, workerId);
    expect(pin.sha).toBe(body.sha);
    expect(pin.sha).not.toBe(beforeSha);
    expect(pin.versionId).toBeNull();
    expect(versionRowCount(h, workerId)).toBe(0);

    // The patch applied AND every other field survived.
    const after = contractAt(wsId, pin.sha!);
    expect(after.systemPrompt).toBe("edited worker prompt");
    expect(after.skills).toEqual(before.skills);
    expect(after.allowedTools).toEqual(before.allowedTools);
    expect(after.allowedCliCommands).toEqual(before.allowedCliCommands);
    expect(after.triggers).toEqual(before.triggers);
    expect(after.seedRefs).toEqual(before.seedRefs);
    expect(after.wakePrograms).toEqual(before.wakePrograms);
    expect(after.framing).toBe(before.framing);
    expect(after.hooks).toBe(before.hooks);
    expect(after.defaultWakeProgram).toBe(before.defaultWakeProgram);

    await teardown(h);
  });

  it("operator triggers PUT advances the manager's commit pin (no demotion), preserving every other field", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    pinToFork(h, managerId, "manager");
    const beforeSha = pinState(h, managerId).sha!;
    const before = upstreamContractAt(beforeSha);

    const triggers = [{ kind: "cron" as const, expr: "0 9 * * *" }];
    const res = await h.server.inject({
      method: "PUT",
      url: `/workspaces/${wsId}/roles/${managerId}/triggers`,
      payload: { triggers },
    });
    expect(res.statusCode).toBe(200);

    const pin = pinState(h, managerId);
    expect(pin.sha).not.toBeNull();
    expect(pin.sha).not.toBe(beforeSha);
    expect(pin.versionId).toBeNull();
    expect(versionRowCount(h, managerId)).toBe(0);

    const after = contractAt(wsId, pin.sha!);
    expect(after.triggers).toEqual(triggers);
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.skills).toEqual(before.skills);
    expect(after.allowedTools).toEqual(before.allowedTools);
    expect(after.seedRefs).toEqual(before.seedRefs);
    expect(after.wakePrograms).toEqual(before.wakePrograms);
    expect(after.framing).toBe(before.framing);
    expect(after.hooks).toBe(before.hooks);

    await teardown(h);
  });

  it("seeds add (PATCH seed_refs) advances the pin and keeps the role commit-pinned + resolvable", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, workerId, "worker");
    const before = upstreamContractAt(pinState(h, workerId).sha!);

    const promptModuleRefs = [...before.seedRefs, { name: "extra-seed", enabled: true }];
    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${workerId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt_module_refs: promptModuleRefs },
    });
    expect(res.statusCode).toBe(200);

    const pin = pinState(h, workerId);
    expect(pin.sha).not.toBeNull();
    expect(pin.versionId).toBeNull();
    expect(versionRowCount(h, workerId)).toBe(0);

    const after = contractAt(wsId, pin.sha!);
    expect(after.seedRefs).toEqual(promptModuleRefs);

    await teardown(h);
  });

  it("a one-shot edit is refused with 409 while the caller has an open checkout for that role", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const managerId = roleId(h, "manager", wsId);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnToken(h, wsId, managerId);
    pinToFork(h, workerId, "worker");

    const co = await h.server.inject({
      method: "POST",
      url: `/agent/roles/${workerId}/checkout`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(co.statusCode).toBe(200);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${workerId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { system_prompt: "clobbering an open checkout" },
    });
    expect(res.statusCode).toBe(409);

    // The pin was not advanced by the refused edit.
    expect(versionRowCount(h, workerId)).toBe(0);

    await teardown(h);
  });
});
