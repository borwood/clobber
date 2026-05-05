import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { SessionSummary } from "../src/workspace-session-summaries.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,

    roleVersions,
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent(),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  });
  return { server, db, workspaces, roles, agents, sessions };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface Seeded {
  readonly workspaceId: string;
  readonly sessionId: string;
}

function seedSession(h: Harness, workspaceName: string): Seeded {
  const ws = h.workspaces.create({ name: workspaceName, repo_path: "/r" });
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
  return { workspaceId: ws.id, sessionId };
}

const baseEnvelope = {
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  permission_mode: "default",
} as const;

describe("GET /sessions — workspace-scoped summaries", () => {
  it("requires workspace_id query param (400 otherwise)", async () => {
    const h = buildHarness();
    const res = await h.server.inject({ method: "GET", url: "/sessions" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe(
      "workspace_id query param is required",
    );
    await teardown(h);
  });

  it("isolates session summaries between two workspaces", async () => {
    const h = buildHarness();
    const a = seedSession(h, "alpha");
    const b = seedSession(h, "beta");

    const aRes = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${a.workspaceId}`,
    })).json() as SessionSummary[];
    const bRes = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${b.workspaceId}`,
    })).json() as SessionSummary[];

    expect(aRes.map((s) => s.session_id)).toEqual([a.sessionId]);
    expect(bRes.map((s) => s.session_id)).toEqual([b.sessionId]);

    await teardown(h);
  });

  it("returns [] when a workspace has no sessions", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "empty", repo_path: "/r" });

    const res = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    })).json() as SessionSummary[];

    expect(res).toEqual([]);
    await teardown(h);
  });

  it("falls back to started_at and event_count=0 when a session has no events yet", async () => {
    const h = buildHarness();
    const seed = seedSession(h, "fresh");

    const res = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${seed.workspaceId}`,
    })).json() as SessionSummary[];

    expect(res).toHaveLength(1);
    const summary = res[0]!;
    expect(summary.session_id).toBe(seed.sessionId);
    expect(summary.event_count).toBe(0);
    expect(summary.last_event_name).toBeUndefined();
    expect(summary.first_seen_at).toBe(summary.last_seen_at);
    expect(typeof summary.first_seen_at).toBe("number");

    await teardown(h);
  });

  it("aggregates first/last seen, event_count, and last_event_name from posted hooks", async () => {
    const h = buildHarness();
    const seed = seedSession(h, "withevents");

    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...baseEnvelope,
        session_id: seed.sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "go",
      },
    });
    await Bun.sleep(2);
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...baseEnvelope,
        session_id: seed.sessionId,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_a",
      },
    });
    await Bun.sleep(2);
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...baseEnvelope,
        session_id: seed.sessionId,
        hook_event_name: "Stop",
      },
    });

    const res = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${seed.workspaceId}`,
    })).json() as SessionSummary[];

    expect(res).toHaveLength(1);
    const summary = res[0]!;
    expect(summary.event_count).toBe(3);
    expect(summary.last_event_name).toBe("Stop");
    expect(summary.first_seen_at).toBeLessThan(summary.last_seen_at);

    await teardown(h);
  });

  it("orders multiple sessions in a workspace by most-recent activity first", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "multi", repo_path: "/r" });
    const role = h.roles.create({ name: `role-${randomUUID()}`, persistent: false });

    function createSession(): string {
      const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
      const id = randomUUID();
      h.sessions.create({
        id,
        agent_id: agent.id,
        workspace_id: ws.id,
        role_id: role.id,
        pid: 9000,
      });
      return id;
    }

    const older = createSession();
    await Bun.sleep(2);
    const newer = createSession();

    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...baseEnvelope,
        session_id: older,
        hook_event_name: "Stop",
      },
    });
    await Bun.sleep(2);
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...baseEnvelope,
        session_id: newer,
        hook_event_name: "Stop",
      },
    });

    const res = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    })).json() as SessionSummary[];

    expect(res.map((s) => s.session_id)).toEqual([newer, older]);
    await teardown(h);
  });

  it("includes role_name on each summary", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: "/r" });
    const role = h.roles.create({ name: "worker-bee", persistent: false });
    const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
    const sessionId = randomUUID();
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    const res = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    })).json() as SessionSummary[];

    expect(res).toHaveLength(1);
    expect(res[0]!.role_name).toBe("worker-bee");

    await teardown(h);
  });

  it("includes label when the spawned agent had one, omits otherwise", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: "/r" });
    const role = h.roles.create({ name: "worker", persistent: false });

    const labeledAgent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "audit-auth",
    });
    const labeledId = randomUUID();
    h.sessions.create({
      id: labeledId,
      agent_id: labeledAgent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    const unlabeledAgent = h.agents.create({ workspace_id: ws.id, role_id: role.id });
    const unlabeledId = randomUUID();
    h.sessions.create({
      id: unlabeledId,
      agent_id: unlabeledAgent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    const res = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    })).json() as SessionSummary[];

    const labeled = res.find((s) => s.session_id === labeledId);
    const unlabeled = res.find((s) => s.session_id === unlabeledId);
    expect(labeled!.label).toBe("audit-auth");
    expect(unlabeled!.label).toBeUndefined();

    await teardown(h);
  });

  it("still surfaces sessions whose agent row was deleted (FK ON DELETE SET NULL)", async () => {
    // FK on sessions.agent_id is ON DELETE SET NULL, so a session can outlive
    // its agent. Summaries must keep showing the role + status even when label
    // is gone with the agent.
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "orphan-ws", repo_path: "/r" });
    const role = h.roles.create({ name: "worker", persistent: false });
    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "doomed-label",
    });
    const sessionId = randomUUID();
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });
    h.db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);

    const res = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${ws.id}`,
    })).json() as SessionSummary[];

    expect(res).toHaveLength(1);
    expect(res[0]!.session_id).toBe(sessionId);
    expect(res[0]!.role_name).toBe("worker");
    expect(res[0]!.label).toBeUndefined();

    await teardown(h);
  });

  it("only counts events for the asked workspace, even if same hook events flow for sessions elsewhere", async () => {
    const h = buildHarness();
    const a = seedSession(h, "a");
    const b = seedSession(h, "b");

    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...baseEnvelope,
        session_id: a.sessionId,
        hook_event_name: "Stop",
      },
    });
    await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        ...baseEnvelope,
        session_id: b.sessionId,
        hook_event_name: "Stop",
      },
    });

    const aRes = (await h.server.inject({
      method: "GET",
      url: `/sessions?workspace_id=${a.workspaceId}`,
    })).json() as SessionSummary[];
    expect(aRes).toHaveLength(1);
    expect(aRes[0]!.session_id).toBe(a.sessionId);
    expect(aRes[0]!.event_count).toBe(1);

    await teardown(h);
  });
});
