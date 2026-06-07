import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { withAgentAuth } from "../src/routes/_with-agent-auth.ts";

interface Harness {
  app: ReturnType<typeof Fastify>;
  managerToken: string;
  workerToken: string;
  endedToken: string;
  repoPath: string;
  db: ReturnType<typeof createDatabase>;
  capturedSessionIds: string[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const repoPath = mkdtempSync(join(tmpdir(), "clobber-with-agent-auth-"));
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });

  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager");
  if (managerRole === null) throw new Error("manager role not seeded");
  const workerRole = roles.findInWorkspace(ws.id, "worker");
  if (workerRole === null) throw new Error("worker role not seeded");

  function mintFor(roleId: string, ended: boolean = false): string {
    const agent = agents.create({ workspace_id: ws.id, role_id: roleId });
    const sessionId = randomUUID();
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleId,
      pid: 1,
    });
    if (ended) sessions.markEnded(sessionId);
    return tokens.mint(sessionId);
  }

  const managerToken = mintFor(managerRole.id);
  const workerToken = mintFor(workerRole.id);
  const endedToken = mintFor(managerRole.id, true);

  const capturedSessionIds: string[] = [];
  const app = Fastify();
  const deps = { sessionTokens: tokens, sessions, roles, roleVersions, workspaces };

  app.get(
    "/test/whoami-route",
    withAgentAuth("whoami", deps, async (_req, _reply, { session }) => {
      capturedSessionIds.push(session.id);
      return { ok: true, session_id: session.id };
    }),
  );

  app.post(
    "/test/spawn-route",
    withAgentAuth("spawn", deps, async (_req, _reply, { session }) => {
      capturedSessionIds.push(session.id);
      return { ok: true, session_id: session.id };
    }),
  );

  return { app, managerToken, workerToken, endedToken, repoPath, db, capturedSessionIds };
}

async function teardown(h: Harness): Promise<void> {
  await h.app.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("withAgentAuth wrapper — auth-failure paths", () => {
  it("401 when authorization header is missing", async () => {
    const h = buildHarness();
    try {
      const res = await h.app.inject({ method: "GET", url: "/test/whoami-route" });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toMatch(/missing or malformed/);
      expect(h.capturedSessionIds).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("401 when authorization header is not a Bearer", async () => {
    const h = buildHarness();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/test/whoami-route",
        headers: { authorization: "Basic deadbeef" },
      });
      expect(res.statusCode).toBe(401);
      expect(h.capturedSessionIds).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("401 when bearer token is invalid", async () => {
    const h = buildHarness();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/test/whoami-route",
        headers: bearer("not-a-real-token"),
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toMatch(/invalid or revoked/);
      expect(h.capturedSessionIds).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("401 when session has ended", async () => {
    const h = buildHarness();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/test/whoami-route",
        headers: bearer(h.endedToken),
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toMatch(/no longer active/);
      expect(h.capturedSessionIds).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("403 when the role's allow-list does not include the command", async () => {
    const h = buildHarness();
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/test/spawn-route",
        headers: bearer(h.workerToken),
      });
      expect(res.statusCode).toBe(403);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/'spawn'/);
      expect(body.error).toMatch(/'worker'/);
      expect(h.capturedSessionIds).toHaveLength(0);
    } finally {
      await teardown(h);
    }
  });

  it("passes the resolved session through to the handler on success", async () => {
    const h = buildHarness();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/test/whoami-route",
        headers: bearer(h.managerToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; session_id: string };
      expect(body.ok).toBe(true);
      expect(h.capturedSessionIds).toEqual([body.session_id]);
    } finally {
      await teardown(h);
    }
  });
});
