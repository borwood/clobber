import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { makeRepoFixture } from "./repo-fixture.ts";
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
    sessionSummaries: createWorkspaceSessionSummaries(db),
    spawner: () => ({ sessionId: "stub", pid: 0, exited: new Promise<number | null>(() => {}) }),
    hookUrl: "http://test.invalid/hook",
  });
  return { server, db };
}

describe("workspaces endpoints", () => {
  it("POST /workspaces creates a workspace and GET /workspaces lists it", async () => {
    const { server, db } = buildServer();
    const repo = makeRepoFixture("clobber-ws-");

    const post = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "runhuman", repo_path: repo.path },
    });

    expect(post.statusCode).toBe(201);
    const created = post.json() as Workspace;
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe("runhuman");
    expect(created.repo_path).toBe(repo.path);
    expect(typeof created.created_at).toBe("number");

    const list = await server.inject({ method: "GET", url: "/workspaces" });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Workspace[];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(created);

    await server.close();
    db.close();
    repo.cleanup();
  });

  it("GET /workspaces/:id returns the workspace by id", async () => {
    const { server, db } = buildServer();
    const repo = makeRepoFixture("clobber-ws-");

    const created = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "alpha", repo_path: repo.path },
    })).json() as Workspace;

    const got = await server.inject({ method: "GET", url: `/workspaces/${created.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json() as unknown).toEqual(created);

    await server.close();
    db.close();
    repo.cleanup();
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
    const repo = makeRepoFixture("clobber-ws-");

    const created = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "beta", repo_path: repo.path },
    })).json() as Workspace;

    const del = await server.inject({ method: "DELETE", url: `/workspaces/${created.id}` });
    expect(del.statusCode).toBe(204);

    const after = await server.inject({ method: "GET", url: `/workspaces/${created.id}` });
    expect(after.statusCode).toBe(404);

    const list = (await server.inject({ method: "GET", url: "/workspaces" })).json() as Workspace[];
    expect(list).toHaveLength(0);

    await server.close();
    db.close();
    repo.cleanup();
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

  it("POST /workspaces rejects a relative repo_path with 400", async () => {
    const { server, db } = buildServer();

    const res = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "rel", repo_path: "relative/path" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe("repo_path must be an absolute path");

    await server.close();
    db.close();
  });

  it("POST /workspaces rejects a repo_path that does not exist with 400", async () => {
    const { server, db } = buildServer();

    const res = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ghost", repo_path: "/this/path/should/not/exist/clobber-ws-test" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe("repo_path does not exist");

    await server.close();
    db.close();
  });

  it("POST /workspaces rejects a repo_path that is a file with 400", async () => {
    const { server, db } = buildServer();
    const tmp = mkdtempSync(join(tmpdir(), "clobber-ws-file-"));
    const filePath = join(tmp, "not-a-dir");
    writeFileSync(filePath, "");

    const res = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "file", repo_path: filePath },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe("repo_path is not a directory");

    rmSync(tmp, { recursive: true, force: true });
    await server.close();
    db.close();
  });

  it("POST /workspaces rejects a directory that is not a git repository with 400", async () => {
    const { server, db } = buildServer();
    const dir = mkdtempSync(join(tmpdir(), "clobber-ws-norepo-"));

    const res = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "norepo", repo_path: dir },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe("repo_path is not a git repository");

    rmSync(dir, { recursive: true, force: true });
    await server.close();
    db.close();
  });

  it("POST /workspaces returns 409 when a name is already taken", async () => {
    const { server, db } = buildServer();
    const a = makeRepoFixture("clobber-ws-");
    const b = makeRepoFixture("clobber-ws-");

    const first = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "dup", repo_path: a.path },
    });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "dup", repo_path: b.path },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: string };
    expect(body.error).toBe("workspace name already exists");

    const list = (await server.inject({ method: "GET", url: "/workspaces" })).json() as Workspace[];
    expect(list).toHaveLength(1);

    await server.close();
    db.close();
    a.cleanup();
    b.cleanup();
  });

  it("GET /workspaces orders most-recently-created first", async () => {
    const { server, db } = buildServer();
    const r1 = makeRepoFixture("clobber-ws-");
    const r2 = makeRepoFixture("clobber-ws-");

    const a = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "first", repo_path: r1.path },
    })).json() as Workspace;
    await Bun.sleep(2);
    const b = (await server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "second", repo_path: r2.path },
    })).json() as Workspace;

    const list = (await server.inject({ method: "GET", url: "/workspaces" })).json() as Workspace[];
    expect(list.map((w) => w.id)).toEqual([b.id, a.id]);

    await server.close();
    db.close();
    r1.cleanup();
    r2.cleanup();
  });
});
