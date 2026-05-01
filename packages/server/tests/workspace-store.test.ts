import { describe, it, expect } from "bun:test";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";

describe("workspace store", () => {
  it("creates a workspace and exposes it via list()", () => {
    const db = createDatabase(":memory:");
    const store = createWorkspaceStore(db);

    const created = store.create({ name: "runhuman", repo_path: "/home/me/runhuman" });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe("runhuman");
    expect(created.repo_path).toBe("/home/me/runhuman");
    expect(typeof created.created_at).toBe("number");

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(created);

    db.close();
  });

  it("retrieves a workspace by id", () => {
    const db = createDatabase(":memory:");
    const store = createWorkspaceStore(db);

    const a = store.create({ name: "a", repo_path: "/tmp/a" });
    const b = store.create({ name: "b", repo_path: "/tmp/b" });

    expect(store.get(a.id)).toEqual(a);
    expect(store.get(b.id)).toEqual(b);

    db.close();
  });

  it("returns null for unknown workspace id", () => {
    const db = createDatabase(":memory:");
    const store = createWorkspaceStore(db);

    expect(store.get("00000000-0000-4000-8000-000000000000")).toBeNull();

    db.close();
  });

  it("rejects duplicate workspace names within the same db", () => {
    const db = createDatabase(":memory:");
    const store = createWorkspaceStore(db);
    store.create({ name: "runhuman", repo_path: "/a" });

    expect(() => store.create({ name: "runhuman", repo_path: "/b" })).toThrow();

    db.close();
  });

  it("orders list() most-recently-created first", async () => {
    const db = createDatabase(":memory:");
    const store = createWorkspaceStore(db);

    const first = store.create({ name: "first", repo_path: "/a" });
    await Bun.sleep(2);
    const second = store.create({ name: "second", repo_path: "/b" });

    const all = store.list();
    expect(all.map((w) => w.id)).toEqual([second.id, first.id]);

    db.close();
  });

  it("deletes a workspace", () => {
    const db = createDatabase(":memory:");
    const store = createWorkspaceStore(db);

    const created = store.create({ name: "tmp", repo_path: "/tmp" });
    expect(store.list()).toHaveLength(1);

    const removed = store.delete(created.id);
    expect(removed).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.get(created.id)).toBeNull();

    expect(store.delete(created.id)).toBe(false);

    db.close();
  });

  it("schema is idempotent — opening the same file twice does not throw", () => {
    const path = `/tmp/clobber-ws-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const a = createDatabase(path);
    const aStore = createWorkspaceStore(a);
    aStore.create({ name: "alpha", repo_path: "/x" });
    a.close();

    const b = createDatabase(path);
    const bStore = createWorkspaceStore(b);
    expect(bStore.list()).toHaveLength(1);
    expect(bStore.list()[0]!.name).toBe("alpha");
    b.close();
  });
});
