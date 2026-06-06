import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
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
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";
import type { Role, Workspace, WorkspaceRoleAssignment, WorkspaceRoleCeiling } from "@clobber/shared";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  repos: RepoFixture[];
}

function buildServer(): Harness {
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
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, repos: [] };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  for (const repo of h.repos) repo.cleanup();
}

async function createWorkspaceViaApi(h: Harness, name: string): Promise<Workspace> {
  const repo = makeRepoFixture("clobber-wsrole-");
  h.repos.push(repo);
  return (await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name, repo_path: repo.path },
  })).json() as Workspace;
}

async function seedWorkspaceAndRole(
  h: Harness,
  workspaceName: string,
  roleName: string,
): Promise<{ ws: Workspace; role: Role }> {
  const ws = await createWorkspaceViaApi(h, workspaceName);
  const role = (await h.server.inject({
    method: "POST",
    url: "/roles",
    payload: { name: roleName, persistent: false },
  })).json() as Role;
  return { ws, role };
}

describe("workspace-role endpoints", () => {
  it("PUT /workspaces/:wid/roles/:rid creates a ceiling and returns it", async () => {
    const h = buildServer();
    const { server } = h;
    const { ws, role } = await seedWorkspaceAndRole(h, "rh", "worker");

    const put = await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: 5 },
    });

    expect(put.statusCode).toBe(200);
    expect(put.json() as unknown).toEqual({
      workspace_id: ws.id,
      role_id: role.id,
      max_concurrent: 5,
    } satisfies WorkspaceRoleCeiling);

    await teardown(h);
  });

  it("PUT updates an existing ceiling (upsert)", async () => {
    const h = buildServer();
    const { server } = h;
    const { ws, role } = await seedWorkspaceAndRole(h, "rh", "worker");

    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: 3 },
    });
    const put = await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: 7 },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as WorkspaceRoleCeiling).max_concurrent).toBe(7);

    const list = (await server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/roles`,
    })).json() as WorkspaceRoleAssignment[];
    const workerEntry = list.find((a) => a.role.id === role.id);
    expect(workerEntry).toBeDefined();
    expect(workerEntry!.max_concurrent).toBe(7);

    await teardown(h);
  });

  it("GET /workspaces/:wid/roles returns joined assignments embedding the role", async () => {
    const h = buildServer();
    const { server } = h;
    const ws = await createWorkspaceViaApi(h, "ws");

    const lead = (await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "lead", persistent: true },
    })).json() as Role;
    const specialist = (await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "specialist", persistent: false },
    })).json() as Role;

    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${lead.id}`,
      payload: { max_concurrent: 1 },
    });
    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${specialist.id}`,
      payload: { max_concurrent: 5 },
    });

    const list = (await server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/roles`,
    })).json() as WorkspaceRoleAssignment[];

    const byRoleId = new Map(list.map((entry) => [entry.role.id, entry]));
    expect(byRoleId.get(lead.id)).toEqual({ role: lead, max_concurrent: 1 });
    expect(byRoleId.get(specialist.id)).toEqual({ role: specialist, max_concurrent: 5 });

    const byName = new Map(list.map((entry) => [entry.role.name, entry]));
    expect(byName.get("manager")?.max_concurrent).toBe(1);
    expect(byName.get("worker")?.max_concurrent).toBe(3);

    await teardown(h);
  });

  it("DELETE /workspaces/:wid/roles/:rid removes the ceiling", async () => {
    const h = buildServer();
    const { server } = h;
    const { ws, role } = await seedWorkspaceAndRole(h, "rh", "worker");

    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: 5 },
    });

    const del = await server.inject({
      method: "DELETE",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
    });
    expect(del.statusCode).toBe(204);

    const list = (await server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/roles`,
    })).json() as WorkspaceRoleAssignment[];
    expect(list.find((a) => a.role.id === role.id)).toBeUndefined();

    const second = await server.inject({
      method: "DELETE",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
    });
    expect(second.statusCode).toBe(404);

    await teardown(h);
  });

  it("PUT rejects an invalid body with 400", async () => {
    const h = buildServer();
    const { server } = h;
    const { ws, role } = await seedWorkspaceAndRole(h, "rh", "worker");

    const negative = await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: -1 },
    });
    expect(negative.statusCode).toBe(400);

    const wrongType = await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: "five" },
    });
    expect(wrongType.statusCode).toBe(400);

    const list = (await server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/roles`,
    })).json() as WorkspaceRoleAssignment[];
    expect(list.find((a) => a.role.id === role.id)).toBeUndefined();

    await teardown(h);
  });

  it("PUT returns 404 for unknown workspace or role", async () => {
    const h = buildServer();
    const { server } = h;
    const { ws, role } = await seedWorkspaceAndRole(h, "rh", "worker");

    const badWs = await server.inject({
      method: "PUT",
      url: `/workspaces/00000000-0000-4000-8000-000000000000/roles/${role.id}`,
      payload: { max_concurrent: 1 },
    });
    expect(badWs.statusCode).toBe(404);

    const badRole = await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/00000000-0000-4000-8000-000000000000`,
      payload: { max_concurrent: 1 },
    });
    expect(badRole.statusCode).toBe(404);

    await teardown(h);
  });

  it("deleting a workspace cascades its ceilings", async () => {
    const h = buildServer();
    const { server } = h;
    const { ws, role } = await seedWorkspaceAndRole(h, "rh", "worker");

    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: 5 },
    });
    expect(
      (await server.inject({ method: "DELETE", url: `/workspaces/${ws.id}` })).statusCode,
    ).toBe(204);

    const list = await server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/roles`,
    });
    expect(list.statusCode).toBe(404);

    await teardown(h);
  });

  it("deleting a role cascades its ceilings across workspaces", async () => {
    const h = buildServer();
    const { server } = h;
    const { ws, role } = await seedWorkspaceAndRole(h, "rh", "worker");

    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
      payload: { max_concurrent: 5 },
    });
    expect(
      (await server.inject({ method: "DELETE", url: `/roles/${role.id}` })).statusCode,
    ).toBe(204);

    const list = (await server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/roles`,
    })).json() as WorkspaceRoleAssignment[];
    expect(list.find((a) => a.role.id === role.id)).toBeUndefined();

    await teardown(h);
  });
});
