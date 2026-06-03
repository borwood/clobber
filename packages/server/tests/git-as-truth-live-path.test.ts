import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { loadRoleBundle, type RoleBundleData } from "@clobber/runtime";
import type { Role } from "@clobber/shared";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import { createServer, type AgentSpawner, type AgentSpawnRequest } from "../src/server.ts";
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
import {
  ensureUpstreamRoleRepo,
  bundleFromContract,
} from "../src/role-repo.ts";
import { createRoleContentCache } from "../src/role-content-cache.ts";
import { embodyRole, rolePin, sessionPin } from "../src/embody-role.ts";
import { roleSnapshotToContract } from "../src/role-tree.ts";
import { snapshotShippedBundle } from "../src/role-version-snapshot.ts";

// #349 pt2 — git-as-truth wired into the live embodiment path. Part 1 (#358)
// shipped the repo + embodiment-from-commit primitive; this proves it is wired
// in: the engine materializes the upstream repo, a role pins a commit ref, and
// embodiment reads its content through a sha-keyed cache — byte-equal to the
// in-memory bundle the row-backed path produces, with the pinned sha surviving
// onto the session so a resume re-resolves the same commit.

// The oracle: the bundle the in-memory (row-backed) embodiment path produces for
// a shipped role, before any git is involved. Mirrors role-repo.test.ts.
function inMemoryBundle(name: string): RoleBundleData {
  const loaded = loadRoleBundle(name);
  if (loaded === null) throw new Error(`no shipped role ${name}`);
  const snapshot = snapshotShippedBundle({ loaded, allowedTools: loaded.allowedTools });
  const contract = roleSnapshotToContract(snapshot);
  return bundleFromContract(contract, {
    pluginName: name,
    description: loaded.manifest.description,
  });
}

function liveStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  roles: ReturnType<typeof createRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  calls: AgentSpawnRequest[];
}

function buildHarness(roleRepoDir: string): Harness {
  const db = createDatabase(":memory:");
  const roles = createRoleStore(db);
  const sessions = createSessionStore(db);
  const calls: AgentSpawnRequest[] = [];
  let counter = 0;
  const spawner: AgentSpawner = (req) => {
    calls.push(req);
    counter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9000 + counter,
      exited: new Promise<number | null>(() => {}),
      stdin: liveStdin(),
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
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
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
  return { server, db, roles, sessions, calls };
}

let repo: RepoFixture;
let roleRepoDir: string;

beforeEach(() => {
  repo = makeRepoFixture("clobber-git-truth-ws-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-git-truth-repo-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("git-as-truth wired into the live path (#349 pt2)", () => {
  it("materializing the upstream repo is idempotent (re-open returns the same fork tips)", () => {
    const first = ensureUpstreamRoleRepo(roleRepoDir);
    const again = ensureUpstreamRoleRepo(roleRepoDir);
    expect(again.forks.get("worker")!.sha).toBe(first.forks.get("worker")!.sha);
    expect(again.forks.get("manager")!.sha).toBe(first.forks.get("manager")!.sha);
  });

  it("embodies a commit-pinned role through the sha-keyed cache, byte-equal to the in-memory bundle", () => {
    const repoHandle = ensureUpstreamRoleRepo(roleRepoDir);
    const fork = repoHandle.forks.get("worker")!;

    const db = createDatabase(":memory:");
    const cache = createRoleContentCache(db);
    const deps = {
      roleVersions: createRoleVersionStore(db),
      roleContentCache: cache,
      roleRepoDir,
    };

    const role: Role = {
      id: randomUUID(),
      name: "worker",
      description: loadRoleBundle("worker")!.manifest.description,
      persistent: false,
      current_commit: { branch: fork.branch, sha: fork.sha },
      created_at: 0,
    };

    expect(cache.get(fork.sha)).toBeNull();
    const bundle = embodyRole(role, rolePin(role), deps);
    expect(bundle).toEqual(inMemoryBundle("worker"));
    // miss populated the cache; a second resolve is a hit on the stored contract.
    expect(cache.get(fork.sha)).not.toBeNull();
    expect(embodyRole(role, rolePin(role), deps)).toEqual(inMemoryBundle("worker"));

    db.close();
  });

  it("a spawn pins the role's commit sha onto the session and embodies its content from git", async () => {
    const h = buildHarness(roleRepoDir);
    const repoHandle = ensureUpstreamRoleRepo(roleRepoDir);
    const fork = repoHandle.forks.get("worker")!;

    const wsRes = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ws", repo_path: repo.path },
    });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json() as { id: string };

    const workerRow = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("worker", ws.id) as { id: string };

    // Flip this seeded role to git-backed: pin its commit ref, drop the row pin.
    h.roles.pinCommit(workerRow.id, { branch: fork.branch, sha: fork.sha });

    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: workerRow.id, prompt: "go", label: "w1" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const spawn = spawnRes.json() as { session_id: string };

    const session = h.sessions.get(spawn.session_id)!;
    expect(session.role_commit).toEqual({ branch: fork.branch, sha: fork.sha });

    // Embodiment sourced the worker's content from the commit, not a role row.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.allowedTools).toEqual(inMemoryBundle("worker").allowedTools);

    await h.server.close();
    h.db.close();
  });

  it("resume re-resolves from the session's pinned commit, not the role's current pointer", async () => {
    const h = buildHarness(roleRepoDir);
    const repoHandle = ensureUpstreamRoleRepo(roleRepoDir);
    const workerFork = repoHandle.forks.get("worker")!;
    const baseSha = repoHandle.baseSha;

    const wsRes = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ws", repo_path: repo.path },
    });
    const ws = wsRes.json() as { id: string };
    const workerRow = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("worker", ws.id) as { id: string };

    h.roles.pinCommit(workerRow.id, { branch: workerFork.branch, sha: workerFork.sha });
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: workerRow.id, prompt: "go", label: "w1" },
    });
    const spawn = spawnRes.json() as { session_id: string };
    const session = h.sessions.get(spawn.session_id)!;

    // The role's current pointer moves on (a later engine advance), but the live
    // session must re-embody the commit it was pinned to.
    h.roles.pinCommit(workerRow.id, { branch: repoHandle.baseBranch, sha: baseSha });
    const role = h.roles.get(workerRow.id)!;

    const pin = sessionPin(session, role);
    expect(pin).toEqual({ kind: "commit", branch: workerFork.branch, sha: workerFork.sha });

    const cache = createRoleContentCache(h.db);
    const resumed = embodyRole(role, pin, {
      roleVersions: createRoleVersionStore(h.db),
      roleContentCache: cache,
      roleRepoDir,
    });
    expect(resumed).toEqual(inMemoryBundle("worker"));

    await h.server.close();
    h.db.close();
  });
});
