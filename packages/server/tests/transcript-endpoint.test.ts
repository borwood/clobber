import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tmp: string;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const tmp = mkdtempSync(join(tmpdir(), "clobber-transcript-"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    store: createEventStore(db),
    workspaces,
    roles,
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    spawner: () => ({ sessionId: "stub", pid: 0 }),
    hookUrl: "http://test.invalid/hook",
  });
  return { server, db, workspaces, roles, agents, sessions, tmp };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
  rmSync(h.tmp, { recursive: true, force: true });
}

interface Seeded {
  readonly sessionId: string;
}

function seedSession(h: Harness): Seeded {
  const ws = h.workspaces.create({ name: `ws-${randomUUID()}`, repo_path: "/r" });
  const role = h.roles.create({ name: `role-${randomUUID()}`, persistent: false });
  const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    pid: 9000,
  });
  return { sessionId };
}

describe("GET /sessions/:id/transcript", () => {
  it("404 when the session does not exist", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${randomUUID()}/transcript`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("session not found");
    await teardown(h);
  });

  it("returns [] when the session has no transcript_path", async () => {
    const h = buildHarness();
    const seed = seedSession(h);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual([]);
    await teardown(h);
  });

  it("returns [] when transcript_path is set but the file does not exist", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    h.sessions.updateTranscriptPath(seed.sessionId, join(h.tmp, "missing.jsonl"));

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual([]);
    await teardown(h);
  });

  it("returns parsed JSONL lines preserving file order", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({ type: "user", message: { role: "user", content: "next" } }),
        "",
      ].join("\n"),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const lines = res.json() as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(3);
    expect(lines[0]!["type"]).toBe("permission-mode");
    expect(lines[1]!["type"]).toBe("assistant");
    expect(lines[2]!["type"]).toBe("user");
    await teardown(h);
  });

  it("skips lines that fail to parse rather than erroring", async () => {
    const h = buildHarness();
    const seed = seedSession(h);
    const path = join(h.tmp, `${seed.sessionId}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }),
        "this-is-not-json{{",
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
      ].join("\n"),
    );
    h.sessions.updateTranscriptPath(seed.sessionId, path);

    const res = await h.server.inject({
      method: "GET",
      url: `/sessions/${seed.sessionId}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    const lines = res.json() as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0]!["type"]).toBe("user");
    expect(lines[1]!["type"]).toBe("assistant");
    await teardown(h);
  });
});
