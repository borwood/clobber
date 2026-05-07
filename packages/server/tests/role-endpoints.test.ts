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
import { stubSpawnedAgent } from "./_spawner-stub.ts";
import type { Role } from "@clobber/shared";

function buildServer() {
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
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
  });
  return { server, db };
}

describe("roles endpoints", () => {
  it("POST /roles creates a minimal role and GET /roles lists it", async () => {
    const { server, db } = buildServer();

    const post = await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker", persistent: false },
    });

    expect(post.statusCode).toBe(201);
    const created = post.json() as Role;
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe("worker");
    expect(created.persistent).toBe(false);
    expect(created.description).toBeUndefined();
    expect(created.allowed_tools).toBeUndefined();

    const list = (await server.inject({ method: "GET", url: "/roles" })).json() as Role[];
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);

    await server.close();
    db.close();
  });

  it("POST /roles round-trips description, permission_mode, allowed_tools, persistent", async () => {
    const { server, db } = buildServer();

    const post = await server.inject({
      method: "POST",
      url: "/roles",
      payload: {
        name: "manager",
        description: "coordinates other agents",
        permission_mode: "acceptEdits",
        allowed_tools: ["Bash", "Read"],
        persistent: true,
      },
    });

    expect(post.statusCode).toBe(201);
    const created = post.json() as Role;
    expect(created.description).toBe("coordinates other agents");
    expect(created.permission_mode).toBe("acceptEdits");
    expect(created.allowed_tools).toEqual(["Bash", "Read"]);
    expect(created.persistent).toBe(true);

    await server.close();
    db.close();
  });

  it("GET /roles/:id returns the role or 404", async () => {
    const { server, db } = buildServer();
    const created = (await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker", persistent: false },
    })).json() as Role;

    const got = await server.inject({ method: "GET", url: `/roles/${created.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json() as unknown).toEqual(created);

    const missing = await server.inject({
      method: "GET",
      url: "/roles/00000000-0000-4000-8000-000000000000",
    });
    expect(missing.statusCode).toBe(404);

    await server.close();
    db.close();
  });

  it("DELETE /roles/:id returns 204 on success and 404 when missing", async () => {
    const { server, db } = buildServer();
    const created = (await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker", persistent: false },
    })).json() as Role;

    const del = await server.inject({ method: "DELETE", url: `/roles/${created.id}` });
    expect(del.statusCode).toBe(204);

    const after = await server.inject({ method: "GET", url: `/roles/${created.id}` });
    expect(after.statusCode).toBe(404);

    const second = await server.inject({ method: "DELETE", url: `/roles/${created.id}` });
    expect(second.statusCode).toBe(404);

    await server.close();
    db.close();
  });

  it("POST /roles rejects an invalid body with 400", async () => {
    const { server, db } = buildServer();

    const noName = await server.inject({
      method: "POST",
      url: "/roles",
      payload: { persistent: false },
    });
    expect(noName.statusCode).toBe(400);
    const body = noName.json() as { error: string; issues: unknown };
    expect(body.error).toBe("invalid role request");
    expect(Array.isArray(body.issues)).toBe(true);

    const noPersistent = await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker" },
    });
    expect(noPersistent.statusCode).toBe(400);

    const badPermissionMode = await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker", persistent: false, permission_mode: "yolo" },
    });
    expect(badPermissionMode.statusCode).toBe(400);

    const list = (await server.inject({ method: "GET", url: "/roles" })).json() as Role[];
    expect(list).toHaveLength(0);

    await server.close();
    db.close();
  });

  it("POST /roles returns 409 when a role name is already taken", async () => {
    const { server, db } = buildServer();

    const first = await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker", persistent: false },
    });
    expect(first.statusCode).toBe(201);

    const dup = await server.inject({
      method: "POST",
      url: "/roles",
      payload: { name: "worker", persistent: true },
    });
    expect(dup.statusCode).toBe(409);
    const body = dup.json() as { error: string };
    expect(body.error).toBe("role name already exists");

    await server.close();
    db.close();
  });
});
