import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import type { Workspace } from "@clobber/shared";

function buildServer() {
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
  return { server, db };
}

describe("workspaces endpoints", () => {
  it("POST /workspaces creates a workspace and GET /workspaces lists it", async () => {
    const { server, db } = buildServer();

    const post = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "runhuman", repo_path: "/repos/runhuman" },
    });

    expect(post.statusCode).toBe(201);
    const created = post.json() as Workspace;
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe("runhuman");
    expect(created.repo_path).toBe("/repos/runhuman");
    expect(typeof created.created_at).toBe("number");

    const list = await server.inject({ method: "GET", url: "/workspaces" });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Workspace[];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(created);

    await server.close();
    db.close();
  });

  it("GET /workspaces/:id returns the workspace by id", async () => {
    const { server, db } = buildServer();

    const created = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "alpha", repo_path: "/r/a" },
    })).json() as Workspace;

    const got = await server.inject({ method: "GET", url: `/workspaces/${created.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json() as unknown).toEqual(created);

    await server.close();
    db.close();
  });

  it("GET /workspaces/:id returns 404 for unknown id", async () => {
    const { server, db } = buildServer();

    const res = await server.inject({
      method: "GET",
      url: "/workspaces/00000000-0000-4000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);

    await server.close();
    db.close();
  });

  it("DELETE /workspaces/:id removes the workspace", async () => {
    const { server, db } = buildServer();

    const created = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "beta", repo_path: "/r/b" },
    })).json() as Workspace;

    const del = await server.inject({ method: "DELETE", url: `/workspaces/${created.id}` });
    expect(del.statusCode).toBe(204);

    const after = await server.inject({ method: "GET", url: `/workspaces/${created.id}` });
    expect(after.statusCode).toBe(404);

    const list = (await server.inject({ method: "GET", url: "/workspaces" })).json() as Workspace[];
    expect(list).toHaveLength(0);

    await server.close();
    db.close();
  });

  it("DELETE /workspaces/:id returns 404 when nothing was deleted", async () => {
    const { server, db } = buildServer();

    const res = await server.inject({
      method: "DELETE",
      url: "/workspaces/00000000-0000-4000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);

    await server.close();
    db.close();
  });

  it("POST /workspaces rejects an invalid body with 400", async () => {
    const { server, db } = buildServer();

    const noName = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { repo_path: "/r/x" },
    });
    expect(noName.statusCode).toBe(400);
    const body = noName.json() as { error: string; issues: unknown };
    expect(body.error).toBe("invalid workspace request");
    expect(Array.isArray(body.issues)).toBe(true);

    const noRepo = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "x" },
    });
    expect(noRepo.statusCode).toBe(400);

    const empties = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "", repo_path: "" },
    });
    expect(empties.statusCode).toBe(400);

    const list = (await server.inject({ method: "GET", url: "/workspaces" })).json() as Workspace[];
    expect(list).toHaveLength(0);

    await server.close();
    db.close();
  });

  it("POST /workspaces returns 409 when a name is already taken", async () => {
    const { server, db } = buildServer();

    const first = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "dup", repo_path: "/r/1" },
    });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "dup", repo_path: "/r/2" },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: string };
    expect(body.error).toBe("workspace name already exists");

    const list = (await server.inject({ method: "GET", url: "/workspaces" })).json() as Workspace[];
    expect(list).toHaveLength(1);

    await server.close();
    db.close();
  });

  it("GET /workspaces orders most-recently-created first", async () => {
    const { server, db } = buildServer();

    const a = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "first", repo_path: "/r/1" },
    })).json() as Workspace;
    await Bun.sleep(2);
    const b = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "second", repo_path: "/r/2" },
    })).json() as Workspace;

    const list = (await server.inject({ method: "GET", url: "/workspaces" })).json() as Workspace[];
    expect(list.map((w) => w.id)).toEqual([b.id, a.id]);

    await server.close();
    db.close();
  });
});
