import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync as _mkdtempSync, rmSync as _rmSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _joinPath, dirname as _dirname } from "node:path";
import { loadRoleContractAtCommit } from "../src/role-repo.ts";
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
import { stubSpawnedAgent } from "./_spawner-stub.ts";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
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
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent(),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    roleRepoDir,
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function roleIdByName(h: Harness, workspaceId: string, name: string): string {
  const row = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get(name, workspaceId) as { id: string } | null;
  if (row === null) throw new Error(`seed missing role: ${name}`);
  return row.id;
}

// #414 — triggers now live in the role's git tree at the commit pin.
function currentTriggers(h: Harness, roleId: string): unknown {
  const role = h.db
    .prepare("SELECT workspace_id, current_commit_sha FROM roles WHERE id = ?")
    .get(roleId) as { workspace_id: string; current_commit_sha: string | null };
  if (role.current_commit_sha === null) {
    throw new Error(`role ${roleId} is not commit-pinned`);
  }
  const clone = _joinPath(_dirname(roleRepoDir), "role-repos", role.workspace_id);
  return loadRoleContractAtCommit(clone, role.current_commit_sha).triggers;
}

function versionRowCount(h: Harness, roleId: string): number {
  return (
    h.db
      .prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?")
      .get(roleId) as { n: number }
  ).n;
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

let repo: RepoFixture;
let roleRepoDir: string;

beforeEach(() => {
  repo = makeRepoFixture("clobber-ws-roles-triggers-");
  roleRepoDir = _mkdtempSync(_joinPath(_tmpdir(), "clobber-rolerepo-"));
});

afterEach(() => {
  repo.cleanup();
  _rmSync(roleRepoDir, { recursive: true, force: true });
});

// PUT /workspaces/:wid/roles/:rid/triggers is the operator-level seam (#186) the
// `clobber workspace create --config` loader (#181) needs: the caller has no
// session in the freshly-created workspace, so it cannot use the agent-scoped
// PATCH /agent/roles/:id. No bearer token here on purpose.
describe("PUT /workspaces/:wid/roles/:rid/triggers — operator trigger apply (#186)", () => {
  it("applies the dogfood manager triggers to a fresh workspace's manager and advances the pin", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const managerId = roleIdByName(h, wid, "manager");

    const triggers = [
      { kind: "workspace-open" },
      { kind: "cron", expr: "0 9 * * *" },
    ];
    const res = await h.server.inject({
      method: "PUT",
      url: `/workspaces/${wid}/roles/${managerId}/triggers`,
      payload: { triggers },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { role_id: string; branch: string; sha: string; no_new_version: boolean };
    expect(body.role_id).toBe(managerId);
    expect(body.no_new_version).toBe(true);
    expect(body.sha.length).toBeGreaterThan(0);

    // The contract canonicalizes triggers by id, so compare as an unordered set.
    const got = currentTriggers(h, managerId) as unknown[];
    expect(got).toHaveLength(triggers.length);
    expect(got).toEqual(expect.arrayContaining(triggers));
    expect(versionRowCount(h, managerId)).toBe(0);

    await teardown(h);
  });

  it("rejects triggers on an ephemeral role with 422 (persistent-only, same guard as PATCH)", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const workerId = roleIdByName(h, wid, "worker");

    const res = await h.server.inject({
      method: "PUT",
      url: `/workspaces/${wid}/roles/${workerId}/triggers`,
      payload: { triggers: [{ kind: "cron", expr: "0 9 * * *" }] },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/persistent/i);

    await teardown(h);
  });

  it("rejects a malformed trigger with 400", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const managerId = roleIdByName(h, wid, "manager");

    const res = await h.server.inject({
      method: "PUT",
      url: `/workspaces/${wid}/roles/${managerId}/triggers`,
      payload: { triggers: [{ kind: "smoke-signal", channel: "1" }] },
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });

  it("404s on unknown workspace and unknown role", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const managerId = roleIdByName(h, wid, "manager");
    const fakeUuid = "00000000-0000-4000-8000-000000000000";

    const badWs = await h.server.inject({
      method: "PUT",
      url: `/workspaces/${fakeUuid}/roles/${managerId}/triggers`,
      payload: { triggers: [] },
    });
    expect(badWs.statusCode).toBe(404);

    const badRole = await h.server.inject({
      method: "PUT",
      url: `/workspaces/${wid}/roles/${fakeUuid}/triggers`,
      payload: { triggers: [] },
    });
    expect(badRole.statusCode).toBe(404);

    await teardown(h);
  });
});
