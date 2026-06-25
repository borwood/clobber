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

function currentContract(h: Harness, roleId: string): ReturnType<typeof loadRoleContractAtCommit> {
  const role = h.db
    .prepare("SELECT workspace_id, current_commit_sha FROM roles WHERE id = ?")
    .get(roleId) as { workspace_id: string; current_commit_sha: string | null };
  if (role.current_commit_sha === null) throw new Error(`role ${roleId} is not commit-pinned`);
  const clone = _joinPath(_dirname(roleRepoDir), "role-repos", role.workspace_id);
  return loadRoleContractAtCommit(clone, role.current_commit_sha);
}

function descriptionOf(h: Harness, roleId: string): string | null {
  return (
    h.db.prepare("SELECT description FROM roles WHERE id = ?").get(roleId) as {
      description: string | null;
    }
  ).description;
}

function pinSha(h: Harness, roleId: string): string | null {
  return (
    h.db.prepare("SELECT current_commit_sha FROM roles WHERE id = ?").get(roleId) as {
      current_commit_sha: string | null;
    }
  ).current_commit_sha;
}

function versionRowCount(h: Harness, roleId: string): number {
  return (
    h.db.prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?").get(roleId) as {
      n: number;
    }
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
  repo = makeRepoFixture("clobber-ws-roles-edit-");
  roleRepoDir = _mkdtempSync(_joinPath(_tmpdir(), "clobber-rolerepo-"));
});

afterEach(() => {
  repo.cleanup();
  _rmSync(roleRepoDir, { recursive: true, force: true });
});

// PATCH/GET /workspaces/:wid/roles/:rid — the operator-level seam (#680) the web
// role editor binds to. No bearer token: the UI has no session in the workspace,
// exactly the reason the agent-scoped PATCH /agent/roles/:id can't serve it.
describe("operator role editor endpoints (#680)", () => {
  it("GET returns the full editable contract for a role", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const workerId = roleIdByName(h, wid, "worker");

    const res = await h.server.inject({
      method: "GET",
      url: `/workspaces/${wid}/roles/${workerId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      name: string;
      current_version: { system_prompt: string; allowed_tools: string[] };
    };
    expect(body.id).toBe(workerId);
    expect(body.name).toBe("worker");
    expect(body.current_version.system_prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(body.current_version.allowed_tools)).toBe(true);

    await teardown(h);
  });

  it("PATCH system_prompt advances the pin and writes the new prompt, no version row", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const workerId = roleIdByName(h, wid, "worker");
    const before = pinSha(h, workerId);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wid}/roles/${workerId}`,
      payload: { system_prompt: "you are a careful UI-authored tester" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { role_id: string; sha: string; no_new_version: boolean };
    expect(body.role_id).toBe(workerId);
    expect(body.no_new_version).toBe(true);

    expect(currentContract(h, workerId).systemPrompt).toBe(
      "you are a careful UI-authored tester",
    );
    expect(pinSha(h, workerId)).not.toBe(before);
    expect(versionRowCount(h, workerId)).toBe(0);

    await teardown(h);
  });

  it("PATCH description-only updates the roles row without advancing the pin", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const workerId = roleIdByName(h, wid, "worker");
    const before = pinSha(h, workerId);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wid}/roles/${workerId}`,
      payload: { description: "hand-authored from the UI" },
    });
    expect(res.statusCode).toBe(200);
    expect(descriptionOf(h, workerId)).toBe("hand-authored from the UI");
    expect(pinSha(h, workerId)).toBe(before);

    await teardown(h);
  });

  it("PATCH rejects triggers on an ephemeral role with 422", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const workerId = roleIdByName(h, wid, "worker");

    const res = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wid}/roles/${workerId}`,
      payload: { triggers: [{ kind: "cron", expr: "0 9 * * *" }] },
    });
    expect(res.statusCode).toBe(422);

    await teardown(h);
  });

  it("PATCH honors the workspace role_edit_policy.forbidden_keys", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const managerId = roleIdByName(h, wid, "manager");

    const policy = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wid}`,
      payload: { role_edit_policy: { forbidden_keys: ["system_prompt"] } },
    });
    expect(policy.statusCode).toBe(200);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wid}/roles/${managerId}`,
      payload: { system_prompt: "should be blocked" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not editable/);

    await teardown(h);
  });

  it("PATCH 400s on an empty body and 404s on unknown role", async () => {
    const h = buildHarness();
    const wid = await createWorkspace(h, repo.path);
    const workerId = roleIdByName(h, wid, "worker");
    const fakeUuid = "00000000-0000-4000-8000-000000000000";

    const empty = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wid}/roles/${workerId}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const badRole = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${wid}/roles/${fakeUuid}`,
      payload: { system_prompt: "x" },
    });
    expect(badRole.statusCode).toBe(404);

    await teardown(h);
  });
});
