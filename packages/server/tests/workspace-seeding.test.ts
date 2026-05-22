import { describe, it, expect } from "bun:test";
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
import { makeRepoFixture } from "./repo-fixture.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";
import type { Workspace, WorkspaceRoleAssignment } from "@clobber/shared";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  cleanups: Array<() => void>;
}

function buildHarness(dbPath = ":memory:"): Harness {
  const db = createDatabase(dbPath);
  const events = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store: events,
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
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
  return { server, db, workspaces, roles, workspaceRoles, cleanups: [] };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  for (const c of h.cleanups) c();
}

async function createWorkspaceViaApi(h: Harness, name: string): Promise<Workspace> {
  const repo = makeRepoFixture("clobber-seed-");
  h.cleanups.push(repo.cleanup);
  const res = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name, repo_path: repo.path },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Workspace;
}

async function listAssignments(
  h: Harness,
  workspaceId: string,
): Promise<WorkspaceRoleAssignment[]> {
  const res = await h.server.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/roles`,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as WorkspaceRoleAssignment[];
}

function tmpDbPath(prefix: string): string {
  return join(
    tmpdir(),
    `clobber-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("workspace seed — POST /workspaces (#24)", () => {
  it("creates workspace-scoped rows for every shipped role on workspace create", async () => {
    const h = buildHarness();
    const ws = await createWorkspaceViaApi(h, "alpha");

    const all = h.roles.list();
    const inWs = all.filter((r) => r.workspace_id === ws.id);
    const names = inWs.map((r) => r.name).sort();
    expect(names).toEqual(["manager", "worker"]);

    for (const r of inWs) {
      expect(r.workspace_id).toBe(ws.id);
      expect(r.current_version_id).toBeDefined();
    }

    await teardown(h);
  });

  it("seeds manager with persistent=true, bypassPermissions, full toolset", async () => {
    const h = buildHarness();
    const ws = await createWorkspaceViaApi(h, "alpha");

    const manager = h.roles.list().find(
      (r) => r.name === "manager" && r.workspace_id === ws.id,
    );
    expect(manager).toBeDefined();
    expect(manager!.persistent).toBe(true);
    expect(manager!.permission_mode).toBe("bypassPermissions");
    expect(manager!.allowed_tools).toEqual([
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
    ]);

    await teardown(h);
  });

  it("seeds worker with persistent=false, bypassPermissions, full toolset", async () => {
    const h = buildHarness();
    const ws = await createWorkspaceViaApi(h, "alpha");

    const worker = h.roles.list().find(
      (r) => r.name === "worker" && r.workspace_id === ws.id,
    );
    expect(worker).toBeDefined();
    expect(worker!.persistent).toBe(false);
    expect(worker!.permission_mode).toBe("bypassPermissions");
    expect(worker!.allowed_tools).toEqual([
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
    ]);

    await teardown(h);
  });

  it("inserts default ceilings (manager=1, worker=3) on workspace create", async () => {
    const h = buildHarness();
    const ws = await createWorkspaceViaApi(h, "alpha");

    const assignments = await listAssignments(h, ws.id);
    expect(assignments).toHaveLength(2);

    const byName = new Map(assignments.map((a) => [a.role.name, a]));
    expect(byName.get("manager")!.max_concurrent).toBe(1);
    expect(byName.get("worker")!.max_concurrent).toBe(3);

    await teardown(h);
  });

  it("each workspace gets its own copy of every shipped role (workspace-scoped)", async () => {
    const h = buildHarness();
    const a = await createWorkspaceViaApi(h, "alpha");
    const b = await createWorkspaceViaApi(h, "beta");

    const aRoles = h.roles.list().filter((r) => r.workspace_id === a.id);
    const bRoles = h.roles.list().filter((r) => r.workspace_id === b.id);

    expect(aRoles).toHaveLength(2);
    expect(bRoles).toHaveLength(2);

    const aManager = aRoles.find((r) => r.name === "manager")!;
    const bManager = bRoles.find((r) => r.name === "manager")!;
    expect(aManager.id).not.toBe(bManager.id);
    expect(aManager.current_version_id).not.toBe(bManager.current_version_id);

    await teardown(h);
  });

  it("each seeded role has a v1 role_versions row pinned via current_version_id", async () => {
    const h = buildHarness();
    const ws = await createWorkspaceViaApi(h, "alpha");

    for (const role of h.roles.list().filter((r) => r.workspace_id === ws.id)) {
      const versionId = role.current_version_id!;
      const versionRow = h.db
        .prepare("SELECT version, role_id, system_prompt FROM role_versions WHERE id = ?")
        .get(versionId) as { version: number; role_id: string; system_prompt: string };
      expect(versionRow.role_id).toBe(role.id);
      expect(versionRow.version).toBe(1);
      expect(versionRow.system_prompt.length).toBeGreaterThan(0);
    }

    await teardown(h);
  });

  it("seeded worker's v1 snapshot embeds the default 5-phase SDLC in its system_prompt (#124)", async () => {
    const h = buildHarness();
    const ws = await createWorkspaceViaApi(h, "alpha");

    const worker = h.roles
      .list()
      .find((r) => r.name === "worker" && r.workspace_id === ws.id)!;
    const row = h.db
      .prepare("SELECT system_prompt FROM role_versions WHERE id = ?")
      .get(worker.current_version_id!) as { system_prompt: string };
    for (const phase of [
      "research",
      "failing-test",
      "implement",
      "open-pr",
      "watch-ci",
    ]) {
      expect(row.system_prompt).toContain(phase);
    }
    expect(row.system_prompt).not.toContain("{{SDLC_PHASES}}");

    await teardown(h);
  });
});

describe("workspace seed — boot-time backfill (#24)", () => {
  it("backfills roles+ceilings for a pre-existing workspace that has none", async () => {
    const path = tmpDbPath("seed-backfill");
    try {
      const db1 = createDatabase(path);
      db1
        .prepare(
          "INSERT INTO workspaces (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          "11111111-1111-4111-8111-111111111111",
          "legacy",
          "/tmp/legacy",
          Date.now(),
        );
      db1.close();

      const db2 = createDatabase(path);
      const roleRows = db2
        .prepare("SELECT name, persistent FROM roles WHERE workspace_id = ?")
        .all("11111111-1111-4111-8111-111111111111") as Array<{
        name: string;
        persistent: number;
      }>;
      expect(roleRows.map((r) => r.name).sort()).toEqual([
        "manager",
        "worker",
      ]);

      const ceilings = db2
        .prepare(
          `SELECT r.name, wrc.max_concurrent
           FROM workspace_role_ceilings wrc
           JOIN roles r ON r.id = wrc.role_id
           WHERE wrc.workspace_id = ?`,
        )
        .all("11111111-1111-4111-8111-111111111111") as Array<{
        name: string;
        max_concurrent: number;
      }>;
      const byName = new Map(ceilings.map((c) => [c.name, c.max_concurrent]));
      expect(byName.get("manager")).toBe(1);
      expect(byName.get("worker")).toBe(3);

      db2.close();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("does not double-seed a workspace that already has roles", async () => {
    const path = tmpDbPath("seed-idempotent");
    try {
      const db1 = createDatabase(path);
      db1
        .prepare(
          "INSERT INTO workspaces (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          "22222222-2222-4222-8222-222222222222",
          "seeded",
          "/tmp/seeded",
          Date.now(),
        );
      db1.close();

      const db2 = createDatabase(path);
      const firstCount = (
        db2
          .prepare("SELECT COUNT(*) AS n FROM roles WHERE workspace_id = ?")
          .get("22222222-2222-4222-8222-222222222222") as { n: number }
      ).n;
      expect(firstCount).toBe(2);
      db2.close();

      const db3 = createDatabase(path);
      const secondCount = (
        db3
          .prepare("SELECT COUNT(*) AS n FROM roles WHERE workspace_id = ?")
          .get("22222222-2222-4222-8222-222222222222") as { n: number }
      ).n;
      expect(secondCount).toBe(2);
      db3.close();
    } finally {
      rmSync(path, { force: true });
    }
  });
});
