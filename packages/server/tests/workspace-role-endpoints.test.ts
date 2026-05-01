import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import type { Role, Workspace, WorkspaceRoleAssignment, WorkspaceRoleCeiling } from "@clobber/shared";

function buildServer() {
  const db = createDatabase(":memory:");
  const server = createServer({
    store: createEventStore(db),
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    spawner: () => ({ sessionId: "stub", pid: 0 }),
    hookUrl: "http://test.invalid/hook",
  });
  return { server, db };
}

async function seedWorkspaceAndRole(
  server: ReturnType<typeof buildServer>["server"],
  workspaceName: string,
  roleName: string,
): Promise<{ ws: Workspace; role: Role }> {
  const ws = (await server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: workspaceName, repo_path: `/r/${workspaceName}` },
  })).json() as Workspace;
  const role = (await server.inject({
    method: "POST",
    url: "/roles",
    payload: { name: roleName, persistent: false },
  })).json() as Role;
  return { ws, role };
}

describe("workspace-role endpoints", () => {
  it("PUT /workspaces/:wid/roles/:rid creates a ceiling and returns it", async () => {
    const { server, db } = buildServer();
    const { ws, role } = await seedWorkspaceAndRole(server, "rh", "worker");

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

    await server.close();
    db.close();
  });

  it("PUT updates an existing ceiling (upsert)", async () => {
    const { server, db } = buildServer();
    const { ws, role } = await seedWorkspaceAndRole(server, "rh", "worker");

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
    expect(list).toHaveLength(1);
    expect(list[0]!.max_concurrent).toBe(7);

    await server.close();
    db.close();
  });

  it("GET /workspaces/:wid/roles returns joined assignments embedding the role", async () => {
    const { server, db } = buildServer();
    const ws = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ws", repo_path: "/r" },
    })).json() as Workspace;

    const manager = (await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "manager", persistent: true },
    })).json() as Role;
    const worker = (await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker", persistent: false },
    })).json() as Role;

    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${manager.id}`,
      payload: { max_concurrent: 1 },
    });
    await server.inject({
      method: "PUT",
      url: `/workspaces/${ws.id}/roles/${worker.id}`,
      payload: { max_concurrent: 5 },
    });

    const list = (await server.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/roles`,
    })).json() as WorkspaceRoleAssignment[];

    expect(list).toHaveLength(2);
    const byName = new Map(list.map((entry) => [entry.role.name, entry]));
    expect(byName.get("manager")).toEqual({ role: manager, max_concurrent: 1 });
    expect(byName.get("worker")).toEqual({ role: worker, max_concurrent: 5 });

    await server.close();
    db.close();
  });

  it("DELETE /workspaces/:wid/roles/:rid removes the ceiling", async () => {
    const { server, db } = buildServer();
    const { ws, role } = await seedWorkspaceAndRole(server, "rh", "worker");

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
    expect(list).toHaveLength(0);

    const second = await server.inject({
      method: "DELETE",
      url: `/workspaces/${ws.id}/roles/${role.id}`,
    });
    expect(second.statusCode).toBe(404);

    await server.close();
    db.close();
  });

  it("PUT rejects an invalid body with 400", async () => {
    const { server, db } = buildServer();
    const { ws, role } = await seedWorkspaceAndRole(server, "rh", "worker");

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
    expect(list).toHaveLength(0);

    await server.close();
    db.close();
  });

  it("PUT returns 404 for unknown workspace or role", async () => {
    const { server, db } = buildServer();
    const { ws, role } = await seedWorkspaceAndRole(server, "rh", "worker");

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

    await server.close();
    db.close();
  });

  it("deleting a workspace cascades its ceilings", async () => {
    const { server, db } = buildServer();
    const { ws, role } = await seedWorkspaceAndRole(server, "rh", "worker");

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

    await server.close();
    db.close();
  });

  it("deleting a role cascades its ceilings across workspaces", async () => {
    const { server, db } = buildServer();
    const { ws, role } = await seedWorkspaceAndRole(server, "rh", "worker");

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
    expect(list).toHaveLength(0);

    await server.close();
    db.close();
  });
});
