import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore, type StoredEvent } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    store,
    workspaces,
    roles,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    spawner: () => stubSpawnedAgent(),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return { server, db, workspaces, roles, workspaceRoles, agents, sessions };
}

async function teardown(h: Harness) {
  await h.server.close();
  h.db.close();
}

interface Seeded {
  readonly workspaceId: string;
  readonly roleId: string;
  readonly agentId: string;
  readonly sessionId: string;
}

function seedSession(h: Harness, opts: { persistent: boolean }): Seeded {
  const ws = h.workspaces.create({
    name: `ws-${randomUUID()}`,
    repo_path: "/r",
  });
  const role = h.roles.create({
    name: `role-${randomUUID()}`,
    persistent: opts.persistent,
  });
  h.workspaceRoles.setCeiling(ws.id, role.id, 1);
  const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    pid: 9000,
  });
  return {
    workspaceId: ws.id,
    roleId: role.id,
    agentId: agent.id,
    sessionId,
  };
}

function envelope(sessionId: string, transcriptPath: string) {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: "/r",
    permission_mode: "default" as const,
  };
}

describe("hook reaper + transcript pickup", () => {
  it("SessionStart writes transcript_path onto the existing session row", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: false });

    expect(h.sessions.get(seed.sessionId)!.transcript_path).toBeUndefined();

    const transcriptPath = `/home/u/.claude/projects/abc/sessions/${seed.sessionId}.jsonl`;
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(seed.sessionId, transcriptPath),
        hook_event_name: "SessionStart",
        source: "startup",
      },
    });
    expect(res.statusCode).toBe(200);

    const session = h.sessions.get(seed.sessionId);
    expect(session!.transcript_path).toBe(transcriptPath);
    expect(session!.ended_at).toBeUndefined();

    await teardown(h);
  });

  it("SessionEnd marks the session ended", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: true });

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(seed.sessionId, "/tmp/t.jsonl"),
        hook_event_name: "SessionEnd",
      },
    });
    expect(res.statusCode).toBe(200);

    const session = h.sessions.get(seed.sessionId);
    expect(session).not.toBeNull();
    expect(typeof session!.ended_at).toBe("number");

    await teardown(h);
  });

  it("SessionEnd reaps an ephemeral agent (session.agent_id becomes undefined via FK SET NULL)", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: false });

    expect(h.agents.get(seed.agentId)).not.toBeNull();

    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(seed.sessionId, "/tmp/t.jsonl"),
        hook_event_name: "SessionEnd",
      },
    });

    expect(h.agents.get(seed.agentId)).toBeNull();
    const session = h.sessions.get(seed.sessionId);
    expect(session).not.toBeNull();
    expect(session!.agent_id).toBeUndefined();
    expect(typeof session!.ended_at).toBe("number");

    await teardown(h);
  });

  it("SessionEnd preserves a persistent agent", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: true });

    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(seed.sessionId, "/tmp/t.jsonl"),
        hook_event_name: "SessionEnd",
      },
    });

    const agent = h.agents.get(seed.agentId);
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe(seed.agentId);

    const session = h.sessions.get(seed.sessionId);
    expect(session!.agent_id).toBe(seed.agentId);
    expect(typeof session!.ended_at).toBe("number");

    await teardown(h);
  });

  it("frees ceiling capacity after ephemeral SessionEnd so a new spawn fits", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: false });

    expect(h.sessions.countActive(seed.workspaceId, seed.roleId)).toBe(1);

    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(seed.sessionId, "/tmp/t.jsonl"),
        hook_event_name: "SessionEnd",
      },
    });

    expect(h.sessions.countActive(seed.workspaceId, seed.roleId)).toBe(0);

    await teardown(h);
  });

  it("hook for an unknown session_id is a no-op but still recorded as an event", async () => {
    const h = buildHarness();
    const unknown = randomUUID();

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(unknown, "/tmp/t.jsonl"),
        hook_event_name: "SessionEnd",
      },
    });
    expect(res.statusCode).toBe(200);

    expect(h.sessions.get(unknown)).toBeNull();

    const events = (
      await h.server.inject({ method: "GET", url: `/events?session_id=${unknown}` })
    ).json() as StoredEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.hook_event_name).toBe("SessionEnd");

    await teardown(h);
  });

  it("UserPromptSubmit picks up transcript_path on a session that has none", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: false });

    expect(h.sessions.get(seed.sessionId)!.transcript_path).toBeUndefined();

    const transcriptPath = `/home/u/.claude/projects/abc/${seed.sessionId}.jsonl`;
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(seed.sessionId, transcriptPath),
        hook_event_name: "UserPromptSubmit",
        prompt: "hello there",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(h.sessions.get(seed.sessionId)!.transcript_path).toBe(transcriptPath);

    await teardown(h);
  });

  it("Stop also picks up transcript_path (claude -p never fires SessionStart)", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: false });

    const transcriptPath = `/home/u/.claude/projects/abc/${seed.sessionId}.jsonl`;
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(seed.sessionId, transcriptPath),
        hook_event_name: "Stop",
      },
    });
    expect(h.sessions.get(seed.sessionId)!.transcript_path).toBe(transcriptPath);

    await teardown(h);
  });

  it("repeated payloads with the same transcript_path are idempotent", async () => {
    const h = buildHarness();
    const seed = seedSession(h, { persistent: false });

    const transcriptPath = `/home/u/.claude/projects/abc/${seed.sessionId}.jsonl`;
    for (let i = 0; i < 3; i++) {
      await h.server.inject({
        method: "POST",
        url: "/hook",
        payload: {
          ...envelope(seed.sessionId, transcriptPath),
          hook_event_name: "UserPromptSubmit",
          prompt: `n${i}`,
        },
      });
    }
    expect(h.sessions.get(seed.sessionId)!.transcript_path).toBe(transcriptPath);

    await teardown(h);
  });

  it("transcript_path pickup for an unknown session_id is a no-op", async () => {
    const h = buildHarness();
    const unknown = randomUUID();

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(unknown, "/tmp/t.jsonl"),
        hook_event_name: "UserPromptSubmit",
        prompt: "hi",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(h.sessions.get(unknown)).toBeNull();

    await teardown(h);
  });

  it("SessionStart for an unknown session_id is also a no-op", async () => {
    const h = buildHarness();
    const unknown = randomUUID();

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...envelope(unknown, "/tmp/t.jsonl"),
        hook_event_name: "SessionStart",
        source: "startup",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(h.sessions.get(unknown)).toBeNull();

    await teardown(h);
  });
});
