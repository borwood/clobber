import { describe, it, expect } from "bun:test";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";

function open() {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const ceilings = createWorkspaceRoleStore(db);
  return { db, workspaces, roles, ceilings };
}

describe("workspace-role store", () => {
  it("setCeiling creates a fresh ceiling and getCeiling reads it back", () => {
    const { db, workspaces, roles, ceilings } = open();
    const ws = workspaces.create({ name: "runhuman", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });

    const created = ceilings.setCeiling(ws.id, role.id, 5);
    expect(created).toEqual({
      workspace_id: ws.id,
      role_id: role.id,
      max_concurrent: 5,
    });

    const fetched = ceilings.getCeiling(ws.id, role.id);
    expect(fetched).toEqual(created);

    db.close();
  });

  it("setCeiling upserts when the same (workspace,role) pair is set again", () => {
    const { db, workspaces, roles, ceilings } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });

    ceilings.setCeiling(ws.id, role.id, 5);
    const updated = ceilings.setCeiling(ws.id, role.id, 12);
    expect(updated.max_concurrent).toBe(12);

    expect(ceilings.listForWorkspace(ws.id)).toHaveLength(1);

    db.close();
  });

  it("getCeiling returns null when the pair has no row", () => {
    const { db, workspaces, roles, ceilings } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });

    expect(ceilings.getCeiling(ws.id, role.id)).toBeNull();
    db.close();
  });

  it("listForWorkspace returns joined assignments with embedded role + ceiling", () => {
    const { db, workspaces, roles, ceilings } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const a = roles.create({ name: "manager", persistent: true });
    const b = roles.create({ name: "worker", persistent: false });

    ceilings.setCeiling(ws.id, a.id, 1);
    ceilings.setCeiling(ws.id, b.id, 5);

    const list = ceilings.listForWorkspace(ws.id);
    expect(list).toHaveLength(2);

    const byName = new Map(list.map((entry) => [entry.role.name, entry]));
    expect(byName.get("manager")).toEqual({ role: a, max_concurrent: 1 });
    expect(byName.get("worker")).toEqual({ role: b, max_concurrent: 5 });

    db.close();
  });

  it("listForWorkspace scopes results to the requested workspace", () => {
    const { db, workspaces, roles, ceilings } = open();
    const a = workspaces.create({ name: "a", repo_path: "/a" });
    const b = workspaces.create({ name: "b", repo_path: "/b" });
    const role = roles.create({ name: "worker", persistent: false });

    ceilings.setCeiling(a.id, role.id, 3);
    ceilings.setCeiling(b.id, role.id, 7);

    expect(ceilings.listForWorkspace(a.id).map((e) => e.max_concurrent)).toEqual([3]);
    expect(ceilings.listForWorkspace(b.id).map((e) => e.max_concurrent)).toEqual([7]);

    db.close();
  });

  it("removeCeiling returns true when removed and false when missing", () => {
    const { db, workspaces, roles, ceilings } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });

    ceilings.setCeiling(ws.id, role.id, 5);
    expect(ceilings.removeCeiling(ws.id, role.id)).toBe(true);
    expect(ceilings.getCeiling(ws.id, role.id)).toBeNull();
    expect(ceilings.removeCeiling(ws.id, role.id)).toBe(false);

    db.close();
  });

  it("cascades when the workspace is deleted", () => {
    const { db, workspaces, roles, ceilings } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });
    ceilings.setCeiling(ws.id, role.id, 5);

    expect(workspaces.delete(ws.id)).toBe(true);
    expect(ceilings.getCeiling(ws.id, role.id)).toBeNull();
    expect(ceilings.listForWorkspace(ws.id)).toHaveLength(0);

    db.close();
  });

  it("cascades when the role is deleted", () => {
    const { db, workspaces, roles, ceilings } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    const role = roles.create({ name: "worker", persistent: false });
    ceilings.setCeiling(ws.id, role.id, 5);

    expect(roles.delete(role.id)).toBe(true);
    expect(ceilings.getCeiling(ws.id, role.id)).toBeNull();

    db.close();
  });

  it("setCeiling rejects setting a ceiling for an unknown workspace via FK", () => {
    const { db, roles, ceilings } = open();
    const role = roles.create({ name: "worker", persistent: false });
    expect(() =>
      ceilings.setCeiling("00000000-0000-4000-8000-000000000000", role.id, 5),
    ).toThrow();
    db.close();
  });

  it("setCeiling rejects setting a ceiling for an unknown role via FK", () => {
    const { db, workspaces, ceilings } = open();
    const ws = workspaces.create({ name: "ws", repo_path: "/r" });
    expect(() =>
      ceilings.setCeiling(ws.id, "00000000-0000-4000-8000-000000000000", 5),
    ).toThrow();
    db.close();
  });
});
