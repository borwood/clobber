import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
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

function currentTriggers(h: Harness, roleId: string): { version: number; triggers: unknown } {
  const role = h.db
    .prepare("SELECT current_version_id FROM roles WHERE id = ?")
    .get(roleId) as { current_version_id: string };
  const version = h.db
    .prepare("SELECT version, triggers_json FROM role_versions WHERE id = ?")
    .get(role.current_version_id) as { version: number; triggers_json: string };
  return { version: version.version, triggers: JSON.parse(version.triggers_json) };
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

beforeEach(() => {
  repo = makeRepoFixture("clobber-ws-roles-triggers-");
});

afterEach(() => {
  repo.cleanup();
});

// PUT /workspaces/:wid/roles/:rid/triggers is the operator-level seam (#186) the
// `clobber workspace create --config` loader (#181) needs: the caller has no
// session in the freshly-created workspace, so it cannot use the agent-scoped
// PATCH /agent/roles/:id. No bearer token here on purpose.
describe("PUT /workspaces/:wid/roles/:rid/triggers — operator trigger apply (#186)", () => {
  it("applies the dogfood manager triggers to a fresh workspace's manager and bumps the version", async () => {
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
    const body = res.json() as { role_id: string; version: number; version_id: string };
    expect(body.role_id).toBe(managerId);
    expect(body.version).toBe(2);

    const after = currentTriggers(h, managerId);
    expect(after.version).toBe(2);
    expect(after.triggers).toEqual(triggers);

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
