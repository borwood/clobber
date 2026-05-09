import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolUsePayload } from "@clobber/shared";
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
import { OFFICE_BOUNDARY_DENIAL } from "../src/office-boundary-guard.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly agents: ReturnType<typeof createAgentStore>;
  readonly sessions: ReturnType<typeof createSessionStore>;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent({ pid: 9999 }),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
  });
  return { server, db, workspaces, roles, agents, sessions };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-office-boundary-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function seedSession(
  h: Harness,
  opts: { persistent?: boolean } = {},
): { agentId: string; sessionId: string } {
  const workspace = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({
    name: `role-${randomUUID()}`,
    persistent: opts.persistent === true,
  });
  const agent = h.agents.create({ workspace_id: workspace.id, role_id: role.id });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: workspace.id,
    role_id: role.id,
    pid: 9000,
  });
  return { agentId: agent.id, sessionId };
}

function preTool(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): PreToolUsePayload {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/transcript.jsonl",
    cwd: repoPath,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: `toolu_${randomUUID()}`,
  };
}

describe("PreToolUse office boundary guard", () => {
  it("allows writes inside the caller's own office", async () => {
    const h = buildHarness();
    const boot = seedSession(h, { persistent: true });

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preTool(boot.sessionId, "Write", {
        file_path: `.clobber/offices/${boot.agentId}/notes.md`,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("blocks direct file writes into another office", async () => {
    const h = buildHarness();
    const boot = seedSession(h, { persistent: true });

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preTool(boot.sessionId, "Edit", {
        file_path: `.clobber/offices/${randomUUID()}/notes.md`,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({
      decision: "block",
      reason: OFFICE_BOUNDARY_DENIAL,
    });
    await teardown(h);
  });

  it("blocks bash redirect writes into another office", async () => {
    const h = buildHarness();
    const boot = seedSession(h, { persistent: true });

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preTool(boot.sessionId, "Bash", {
        command: `printf hi > .clobber/offices/${randomUUID()}/notes.md`,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({
      decision: "block",
      reason: OFFICE_BOUNDARY_DENIAL,
    });
    await teardown(h);
  });

  it("blocks ephemeral agents from creating an office under their own agent id", async () => {
    const h = buildHarness();
    const boot = seedSession(h, { persistent: false });

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preTool(boot.sessionId, "Write", {
        file_path: `.clobber/offices/${boot.agentId}/notes.md`,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({
      decision: "block",
      reason: OFFICE_BOUNDARY_DENIAL,
    });
    await teardown(h);
  });

  it("does not block non-office writes", async () => {
    const h = buildHarness();
    const boot = seedSession(h);

    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preTool(boot.sessionId, "Write", { file_path: "src/outside.txt" }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});
