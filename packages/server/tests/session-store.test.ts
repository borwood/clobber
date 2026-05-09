import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";

function open() {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  return { db, workspaces, roles, agents, sessions };
}

function seed(deps: ReturnType<typeof open>) {
  const ws = deps.workspaces.create({ name: "ws", repo_path: "/r" });
  const role = deps.roles.create({ name: "worker", persistent: false });
  const agent = deps.agents.create({ workspace_id: ws.id, role_id: role.id });
  return { ws, role, agent };
}

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "clobber-session-runtime-"));
  return join(dir, "clobber.db");
}

describe("session store", () => {
  it("create persists a session and get reads it back", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);

    const created = deps.sessions.create({
      id: "claude-session-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1234,
    });

    expect(created.id).toBe("claude-session-1");
    expect(created.agent_id).toBe(agent.id);
    expect(created.workspace_id).toBe(ws.id);
    expect(created.role_id).toBe(role.id);
    expect(created.runtime_provider).toBe("claude");
    expect(created.provider_thread_id).toBeUndefined();
    expect(created.pid).toBe(1234);
    expect(created.started_at).toBeGreaterThan(0);
    expect(created.ended_at).toBeUndefined();
    expect(created.transcript_path).toBeUndefined();

    expect(deps.sessions.get("claude-session-1")).toEqual(created);
    deps.db.close();
  });

  it("create persists runtime provider and provider thread identity", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);

    const created = deps.sessions.create({
      id: "local-run-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      runtime_provider: "codex",
      provider_thread_id: "codex-thread-1",
      pid: 1234,
    });

    expect(created.runtime_provider).toBe("codex");
    expect(created.provider_thread_id).toBe("codex-thread-1");
    expect(deps.sessions.get("local-run-1")).toEqual(created);
    deps.db.close();
  });

  it("backfills runtime identity columns for a legacy sessions table", () => {
    const path = tmpDbPath();
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE sessions (
          id              TEXT    PRIMARY KEY,
          agent_id        TEXT,
          workspace_id    TEXT    NOT NULL,
          role_id         TEXT    NOT NULL,
          role_version_id TEXT,
          label           TEXT,
          pid             INTEGER NOT NULL,
          started_at      INTEGER NOT NULL,
          ended_at        INTEGER,
          transcript_path TEXT
        );
        INSERT INTO sessions (id, workspace_id, role_id, pid, started_at)
        VALUES ('legacy-session-1', 'workspace-1', 'role-1', 777, 123456);
      `);
      legacy.close();

      const db = createDatabase(path);
      const row = db
        .prepare(
          "SELECT runtime_provider, provider_thread_id FROM sessions WHERE id = ?",
        )
        .get("legacy-session-1") as {
        runtime_provider: string;
        provider_thread_id: string | null;
      };

      expect(row.runtime_provider).toBe("claude");
      expect(row.provider_thread_id).toBe("legacy-session-1");
      db.close();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("create accepts an optional transcript_path", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);

    const created = deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 99,
      transcript_path: "/transcripts/s1.jsonl",
    });

    expect(created.transcript_path).toBe("/transcripts/s1.jsonl");
    deps.db.close();
  });

  it("get returns null for an unknown id", () => {
    const deps = open();
    expect(deps.sessions.get("nope")).toBeNull();
    deps.db.close();
  });

  it("countActive only counts sessions with ended_at IS NULL", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);

    deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });
    deps.sessions.create({
      id: "s2",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 2,
    });

    expect(deps.sessions.countActive(ws.id, role.id)).toBe(2);

    deps.sessions.markEnded("s1");
    expect(deps.sessions.countActive(ws.id, role.id)).toBe(1);

    deps.sessions.markEnded("s2");
    expect(deps.sessions.countActive(ws.id, role.id)).toBe(0);

    deps.db.close();
  });

  it("countActive scopes by workspace + role", () => {
    const deps = open();
    const wsA = deps.workspaces.create({ name: "a", repo_path: "/a" });
    const wsB = deps.workspaces.create({ name: "b", repo_path: "/b" });
    const r1 = deps.roles.create({ name: "worker", persistent: false });
    const r2 = deps.roles.create({ name: "manager", persistent: true });
    const agentA1 = deps.agents.create({ workspace_id: wsA.id, role_id: r1.id });
    const agentA2 = deps.agents.create({ workspace_id: wsA.id, role_id: r2.id });
    const agentB1 = deps.agents.create({ workspace_id: wsB.id, role_id: r1.id });

    deps.sessions.create({
      id: "a1",
      agent_id: agentA1.id,
      workspace_id: wsA.id,
      role_id: r1.id,
      pid: 1,
    });
    deps.sessions.create({
      id: "a2",
      agent_id: agentA2.id,
      workspace_id: wsA.id,
      role_id: r2.id,
      pid: 2,
    });
    deps.sessions.create({
      id: "b1",
      agent_id: agentB1.id,
      workspace_id: wsB.id,
      role_id: r1.id,
      pid: 3,
    });

    expect(deps.sessions.countActive(wsA.id, r1.id)).toBe(1);
    expect(deps.sessions.countActive(wsA.id, r2.id)).toBe(1);
    expect(deps.sessions.countActive(wsB.id, r1.id)).toBe(1);
    expect(deps.sessions.countActive(wsB.id, r2.id)).toBe(0);

    deps.db.close();
  });

  it("markEnded sets ended_at and returns true; subsequent calls return false", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);
    deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    expect(deps.sessions.markEnded("s1")).toBe(true);
    const fetched = deps.sessions.get("s1");
    expect(fetched!.ended_at).toBeGreaterThan(0);

    expect(deps.sessions.markEnded("s1")).toBe(false);
    expect(deps.sessions.markEnded("missing")).toBe(false);

    deps.db.close();
  });

  it("updateTranscriptPath stores the path and returns true; false when unknown", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);
    deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    expect(deps.sessions.updateTranscriptPath("s1", "/tx.jsonl")).toBe(true);
    expect(deps.sessions.get("s1")!.transcript_path).toBe("/tx.jsonl");

    expect(deps.sessions.updateTranscriptPath("missing", "/x")).toBe(false);

    deps.db.close();
  });

  it("listForWorkspace returns sessions newest-first scoped to the workspace", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);
    const otherWs = deps.workspaces.create({ name: "other", repo_path: "/x" });
    const otherAgent = deps.agents.create({ workspace_id: otherWs.id, role_id: role.id });

    const s1 = deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });
    const s2 = deps.sessions.create({
      id: "s2",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 2,
    });
    deps.sessions.create({
      id: "other",
      agent_id: otherAgent.id,
      workspace_id: otherWs.id,
      role_id: role.id,
      pid: 3,
    });

    const list = deps.sessions.listForWorkspace(ws.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(s2.id);
    expect(list[1]!.id).toBe(s1.id);

    deps.db.close();
  });

  it("agent deletion sets session.agent_id to NULL but keeps the session", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);
    deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    expect(deps.agents.delete(agent.id)).toBe(true);

    const fetched = deps.sessions.get("s1");
    expect(fetched).not.toBeNull();
    expect(fetched!.agent_id).toBeUndefined();
    expect(fetched!.workspace_id).toBe(ws.id);
    expect(fetched!.role_id).toBe(role.id);

    deps.db.close();
  });

  it("workspace deletion cascades to sessions", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);
    deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    expect(deps.workspaces.delete(ws.id)).toBe(true);
    expect(deps.sessions.get("s1")).toBeNull();
    deps.db.close();
  });

  it("role deletion cascades to sessions", () => {
    const deps = open();
    const { ws, role, agent } = seed(deps);
    deps.sessions.create({
      id: "s1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    expect(deps.roles.delete(role.id)).toBe(true);
    expect(deps.sessions.get("s1")).toBeNull();
    deps.db.close();
  });

  it("rejects creating a session for an unknown agent via FK", () => {
    const deps = open();
    const ws = deps.workspaces.create({ name: "ws", repo_path: "/r" });
    const role = deps.roles.create({ name: "w", persistent: false });
    expect(() =>
      deps.sessions.create({
        id: "s1",
        agent_id: "00000000-0000-4000-8000-000000000000",
        workspace_id: ws.id,
        role_id: role.id,
        pid: 1,
      }),
    ).toThrow();
    deps.db.close();
  });
});
