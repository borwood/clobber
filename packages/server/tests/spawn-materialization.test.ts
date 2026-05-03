import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import type { AgentSpawner, AgentSpawnRequest } from "../src/types.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-spawn-mat-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  sessionTokens: ReturnType<typeof createSessionTokenStore>;
  calls: AgentSpawnRequest[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionTokens = createSessionTokenStore(db);
  const calls: AgentSpawnRequest[] = [];
  const spawner: AgentSpawner = (req) => {
    calls.push(req);
    const stdin = new PassThrough();
    stdin.resume();
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 8123,
      exited: new Promise<number | null>(() => {}),
      stdin,
    };
  };
  const server = createServer({
    store: createEventStore(db),
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens,
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
    apiBase: "http://127.0.0.1:3300",
    cliEntry: "/abs/cli/index.ts",
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, sessionTokens, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

describe("POST /spawn — manager bundle materialization", () => {
  it("materializes the manager bundle into the workspace cwd and threads token+env", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; pid: number };

    expect(existsSync(join(repoPath, ".claude", "skills", "manager", "whoami.md"))).toBe(true);
    expect(existsSync(join(repoPath, ".claude", "skills", "manager", "spawn.md"))).toBe(true);
    expect(existsSync(join(repoPath, ".clobber", "bin", "clobber"))).toBe(true);

    const session = h.sessions.get(body.session_id);
    expect(session).not.toBeNull();
    expect(session!.pid).toBe(8123);

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.sessionId).toBe(body.session_id);
    expect(call.cwd).toBe(repoPath);
    expect(call.env).toBeDefined();
    expect(call.env!["CLOBBER_API_BASE"]).toBe("http://127.0.0.1:3300");
    expect(call.env!["CLOBBER_SESSION_ID"]).toBe(body.session_id);
    expect(call.env!["CLOBBER_WORKSPACE_ID"]).toBe(ws.id);
    expect(call.env!["CLOBBER_ROLE"]).toBe("manager");
    const passedToken = call.env!["CLOBBER_SESSION_TOKEN"];
    expect(typeof passedToken).toBe("string");
    expect(h.sessionTokens.lookup(passedToken!)?.session_id).toBe(body.session_id);

    expect(call.settings).toBeDefined();
    expect(JSON.stringify(call.settings)).toContain("http://127.0.0.1:3300/hook");

    const path = call.env!["PATH"]!;
    expect(path.startsWith(join(repoPath, ".clobber", "bin"))).toBe(true);

    const shim = readFileSync(join(repoPath, ".clobber", "bin", "clobber"), "utf8");
    expect(shim).toContain("/abs/cli/index.ts");

    await teardown(h);
  });

  it("does not materialize for unknown role names", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "no-bundle-here", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go" },
    });
    expect(res.statusCode).toBe(200);

    expect(existsSync(join(repoPath, ".claude"))).toBe(false);
    expect(existsSync(join(repoPath, ".clobber"))).toBe(false);

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.env).toBeUndefined();
    expect(call.settings).toBeUndefined();

    await teardown(h);
  });
});

describe("endSession revokes the session token (issue #16)", () => {
  it("after /sessions/:id/end, the token no longer authenticates /agent/me", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go" },
    });
    const body = res.json() as { session_id: string };
    const token = h.calls[0]!.env!["CLOBBER_SESSION_TOKEN"]!;
    expect(h.sessionTokens.lookup(token)).not.toBeNull();

    const endRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${body.session_id}/end`,
    });
    expect(endRes.statusCode).toBe(200);

    expect(h.sessionTokens.lookup(token)).toBeNull();

    const meRes = await h.server.inject({
      method: "GET",
      url: "/agent/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(401);

    await teardown(h);
  });
});
