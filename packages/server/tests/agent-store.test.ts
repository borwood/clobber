import { describe, it, expect } from "bun:test";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";

function open() {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  return { db, workspaces, roles, agents };
}

describe("agent store", () => {
  it("create returns a fully shaped agent and get reads it back", () => {
    const { db, workspaces, roles, agents } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "manager", persistent: true });

    const created = agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "primary",
    });

    expect(created.workspace_id).toBe(ws.id);
    expect(created.role_id).toBe(role.id);
    expect(created.label).toBe("primary");
    expect(typeof created.id).toBe("string");
    expect(created.created_at).toBeGreaterThan(0);

    const fetched = agents.get(created.id);
    expect(fetched).toEqual(created);

    db.close();
  });

  it("create works without a label", () => {
    const { db, workspaces, roles, agents } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });

    const created = agents.create({ workspace_id: ws.id, role_id: role.id });
    expect(created.label).toBeUndefined();
    expect(agents.get(created.id)).toEqual(created);

    db.close();
  });

  it("get returns null for an unknown id", () => {
    const { db, agents } = open();
    expect(agents.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    db.close();
  });

  it("listForWorkspace returns agents scoped to the workspace, newest first", () => {
    const { db, workspaces, roles, agents } = open();
    const a = workspaces.create({ name: "a", repo_path: "/a" });
    const b = workspaces.create({ name: "b", repo_path: "/b" });
    const role = roles.create({ name: "worker", persistent: false });

    const first = agents.create({ workspace_id: a.id, role_id: role.id, label: "one" });
    const second = agents.create({ workspace_id: a.id, role_id: role.id, label: "two" });
    agents.create({ workspace_id: b.id, role_id: role.id, label: "other" });

    const listed = agents.listForWorkspace(a.id);
    expect(listed).toHaveLength(2);
    expect(listed[0]!.id).toBe(second.id);
    expect(listed[1]!.id).toBe(first.id);

    db.close();
  });

  it("delete returns true when removed and false when missing", () => {
    const { db, workspaces, roles, agents } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id });

    expect(agents.delete(agent.id)).toBe(true);
    expect(agents.get(agent.id)).toBeNull();
    expect(agents.delete(agent.id)).toBe(false);

    db.close();
  });

  it("cascades when the workspace is deleted", () => {
    const { db, workspaces, roles, agents } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id });

    expect(workspaces.delete(ws.id)).toBe(true);
    expect(agents.get(agent.id)).toBeNull();

    db.close();
  });

  it("cascades when the role is deleted", () => {
    const { db, workspaces, roles, agents } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id });

    expect(roles.delete(role.id)).toBe(true);
    expect(agents.get(agent.id)).toBeNull();

    db.close();
  });

  it("rejects creating an agent for an unknown workspace via FK", () => {
    const { db, roles, agents } = open();
    const role = roles.create({ name: "worker", persistent: false });
    expect(() =>
      agents.create({
        workspace_id: "00000000-0000-4000-8000-000000000000",
        role_id: role.id,
      }),
    ).toThrow();
    db.close();
  });

  it("rejects creating an agent for an unknown role via FK", () => {
    const { db, workspaces, agents } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    expect(() =>
      agents.create({
        workspace_id: ws.id,
        role_id: "00000000-0000-4000-8000-000000000000",
      }),
    ).toThrow();
    db.close();
  });
});
