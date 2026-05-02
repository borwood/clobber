import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";

function buildHarness() {
  const db = createDatabase(":memory:");
  let invocations = 0;
  const server = createServer({
    store: createEventStore(db),
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
    spawner: () => {
      invocations += 1;
      return { sessionId: "x", pid: 0 };
    },
    hookUrl: "http://test.invalid/hook",
  });
  return {
    server,
    db,
    invocationCount: () => invocations,
  };
}

describe("POST /spawn — request validation", () => {
  it("rejects a request missing prompt with 400 and does not spawn", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: "00000000-0000-4000-8000-000000000001",
        role_id: "00000000-0000-4000-8000-000000000002",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(h.invocationCount()).toBe(0);

    await h.server.close();
    h.db.close();
  });

  it("rejects a request missing workspace_id with 400", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { role_id: "00000000-0000-4000-8000-000000000002", prompt: "hi" },
    });

    expect(res.statusCode).toBe(400);
    expect(h.invocationCount()).toBe(0);

    await h.server.close();
    h.db.close();
  });

  it("rejects a request missing role_id with 400", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: "00000000-0000-4000-8000-000000000001", prompt: "hi" },
    });

    expect(res.statusCode).toBe(400);
    expect(h.invocationCount()).toBe(0);

    await h.server.close();
    h.db.close();
  });

  it("rejects non-uuid workspace_id with 400", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: "not-a-uuid",
        role_id: "00000000-0000-4000-8000-000000000002",
        prompt: "hi",
      },
    });

    expect(res.statusCode).toBe(400);

    await h.server.close();
    h.db.close();
  });
});
