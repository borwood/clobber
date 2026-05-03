import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import type { Role, Workspace, WorkspaceRoleAssignment } from "@clobber/shared";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  roles: ReturnType<typeof createRoleStore>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const events = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    store: events,
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    spawner: () => ({ sessionId: "stub", pid: 0 }),
    hookUrl: "http://test.invalid/hook",
  });
  return { server, db, roles };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
}

async function createWorkspace(h: Harness, name: string, repo: string): Promise<Workspace> {
  const res = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name, repo_path: repo },
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

describe("workspace bootstrap — manager auto-seed", () => {
  it("creates the 'manager' role with sensible defaults on first workspace", async () => {
    const h = buildHarness();
    expect(h.roles.findByName("manager")).toBeNull();

    await createWorkspace(h, "alpha", "/r/a");

    const manager = h.roles.findByName("manager");
    expect(manager).not.toBeNull();
    const m = manager as Role;
    expect(m.name).toBe("manager");
    expect(m.persistent).toBe(true);
    expect(m.permission_mode).toBe("bypassPermissions");
    expect(m.allowed_tools).toEqual(["Bash", "Read", "Edit", "Write", "Glob", "Grep"]);

    await teardown(h);
  });

  it("sets ceiling=1 for (workspace, manager) on creation", async () => {
    const h = buildHarness();

    const ws = await createWorkspace(h, "alpha", "/r/a");
    const assignments = await listAssignments(h, ws.id);

    expect(assignments).toHaveLength(1);
    const assignment = assignments[0]!;
    expect(assignment.max_concurrent).toBe(1);
    expect(assignment.role.name).toBe("manager");

    await teardown(h);
  });

  it("reuses the same manager role across multiple workspaces", async () => {
    const h = buildHarness();

    const a = await createWorkspace(h, "alpha", "/r/a");
    const b = await createWorkspace(h, "beta", "/r/b");

    const aAssignments = await listAssignments(h, a.id);
    const bAssignments = await listAssignments(h, b.id);

    expect(aAssignments[0]!.role.id).toBe(bAssignments[0]!.role.id);

    const allManagers = h.roles.list().filter((r) => r.name === "manager");
    expect(allManagers).toHaveLength(1);

    await teardown(h);
  });
});
