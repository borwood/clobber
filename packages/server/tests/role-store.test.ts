import { describe, it, expect } from "bun:test";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";
import type { CreateRoleRequest } from "@clobber/shared";

function open(path: string = ":memory:") {
  const db = createDatabase(path);
  const store = createRoleStore(db);
  return { db, store };
}

const minimal: CreateRoleRequest = {
  name: "worker",
  persistent: false,
};

const fullySpecified: CreateRoleRequest = {
  name: "manager",
  description: "coordinates other agents",
  permission_mode: "acceptEdits",
  allowed_tools: ["Bash", "Read", "Write"],
  effort: "xhigh",
  model: "opus",
  persistent: true,
};

describe("role store", () => {
  it("creates a minimal role and returns it via list()", () => {
    const { db, store } = open();

    const created = store.create(minimal);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe("worker");
    expect(created.persistent).toBe(false);
    expect(created.description).toBeUndefined();
    expect(created.permission_mode).toBeUndefined();
    expect(created.allowed_tools).toBeUndefined();
    expect(typeof created.created_at).toBe("number");

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(created);

    db.close();
  });

  it("creates a fully-specified role and round-trips all fields", () => {
    const { db, store } = open();

    const created = store.create(fullySpecified);
    expect(created.name).toBe("manager");
    expect(created.description).toBe("coordinates other agents");
    expect(created.permission_mode).toBe("acceptEdits");
    expect(created.allowed_tools).toEqual(["Bash", "Read", "Write"]);
    expect(created.effort).toBe("xhigh");
    expect(created.model).toBe("opus");
    expect(created.persistent).toBe(true);

    const fetched = store.get(created.id)!;
    expect(fetched).toEqual(created);

    db.close();
  });

  it("leaves effort undefined when not supplied on create", () => {
    const { db, store } = open();
    const created = store.create(minimal);
    expect(created.effort).toBeUndefined();
    db.close();
  });

  it("leaves model undefined when not supplied on create", () => {
    const { db, store } = open();
    const created = store.create(minimal);
    expect(created.model).toBeUndefined();
    db.close();
  });

  it("get() returns null for an unknown id", () => {
    const { db, store } = open();
    expect(store.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    db.close();
  });

  it("findByName() returns the role or null", () => {
    const { db, store } = open();
    const created = store.create(minimal);
    expect(store.findByName("worker")).toEqual(created);
    expect(store.findByName("nope")).toBeNull();
    db.close();
  });

  it("rejects duplicate names at the DB layer", () => {
    const { db, store } = open();
    store.create(minimal);
    expect(() => store.create(minimal)).toThrow();
    db.close();
  });

  it("delete() returns true when removed and false when missing", () => {
    const { db, store } = open();
    const created = store.create(minimal);
    expect(store.delete(created.id)).toBe(true);
    expect(store.get(created.id)).toBeNull();
    expect(store.delete(created.id)).toBe(false);
    db.close();
  });

  it("list() orders most-recently-created first", async () => {
    const { db, store } = open();
    const a = store.create({ name: "first", persistent: false });
    await Bun.sleep(2);
    const b = store.create({ name: "second", persistent: false });

    const list = store.list();
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);

    db.close();
  });

  it("persists roles across reopens of the same file", () => {
    const path = `/tmp/clobber-roles-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const first = open(path);
    const created = first.store.create(fullySpecified);
    first.db.close();

    const second = open(path);
    const reread = second.store.get(created.id)!;
    expect(reread).toEqual(created);
    second.db.close();
  });
});
