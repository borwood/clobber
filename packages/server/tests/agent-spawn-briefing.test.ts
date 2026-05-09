import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
import type {
  AgentSpawner,
  AgentSpawnRequest,
  SpawnedAgentInfo,
} from "../src/types.ts";

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  readonly tokens: ReturnType<typeof createSessionTokenStore>;
  readonly calls: AgentSpawnRequest[];
  readonly repoPath: string;
}

let h: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeEach(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-briefing-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const calls: AgentSpawnRequest[] = [];
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    calls.push(req);
    return {
      sessionId: req.sessionId!,
      pid: 4321,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
  });
  h = {
    server,
    db,
    workspaces,
    roles,
    workspaceRoles,
    tokens,
    calls,
    repoPath,
  };
});

afterEach(async () => {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
});

async function bootManager(): Promise<{ token: string; workspaceId: string }> {
  const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
  const managerRole = h.roles.create({ name: "manager", persistent: true });
  const workerBeeRole = h.roles.create({ name: "worker-bee", persistent: false });
  h.workspaceRoles.setCeiling(ws.id, managerRole.id, 1);
  h.workspaceRoles.setCeiling(ws.id, workerBeeRole.id, 3);

  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string };
  return { token: h.tokens.mint(body.session_id), workspaceId: ws.id };
}

describe("POST /agent/spawn — briefing packet", () => {
  it("writes briefing files to .clobber/agents/<id>/desk/ and exposes CLOBBER_DESK_DIR before the spawner runs", async () => {
    const { token } = await bootManager();
    const seedTodos = JSON.stringify([
      { content: "research #82", status: "in_progress", activeForm: "researching" },
    ]);
    const callsBefore = h.calls.length;
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        role: "worker-bee",
        prompt: "ship #82",
        label: "issue-82",
        briefing: {
          files: [
            { name: "seed-todos.json", content: seedTodos },
            { name: "assignment.md", content: "# Assignment\n\nShip issue 82." },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agent_id: string };

    const deskDir = join(
      h.repoPath,
      ".clobber",
      "agents",
      body.agent_id,
      "desk",
    );
    expect(existsSync(deskDir)).toBe(true);
    expect(readFileSync(join(deskDir, "seed-todos.json"), "utf8")).toBe(seedTodos);
    expect(readFileSync(join(deskDir, "assignment.md"), "utf8")).toMatch(/Ship issue 82/);

    expect(h.calls.length).toBe(callsBefore + 1);
    const call = h.calls[h.calls.length - 1]!;
    expect(call.env?.["CLOBBER_DESK_DIR"]).toBe(deskDir);
  });

  it("writes nested briefing files preserving subdirectories", async () => {
    const { token } = await bootManager();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        role: "worker-bee",
        prompt: "p",
        label: "nested",
        briefing: {
          files: [
            { name: "context/conventions.md", content: "use squash merges" },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agent_id: string };
    const deskDir = join(h.repoPath, ".clobber", "agents", body.agent_id, "desk");
    expect(readFileSync(join(deskDir, "context", "conventions.md"), "utf8")).toBe(
      "use squash merges",
    );
  });

  it("rejects briefing files with parent-directory traversal in the name", async () => {
    const { token } = await bootManager();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        role: "worker-bee",
        prompt: "p",
        label: "nope",
        briefing: { files: [{ name: "../etc/passwd", content: "x" }] },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects briefing files with absolute paths in the name", async () => {
    const { token } = await bootManager();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        role: "worker-bee",
        prompt: "p",
        label: "nope",
        briefing: { files: [{ name: "/etc/passwd", content: "x" }] },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects duplicate briefing file names", async () => {
    const { token } = await bootManager();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        role: "worker-bee",
        prompt: "p",
        label: "dup",
        briefing: {
          files: [
            { name: "a.md", content: "1" },
            { name: "a.md", content: "2" },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not create the desk directory when no briefing files are provided", async () => {
    const { token } = await bootManager();
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "worker-bee", prompt: "p", label: "no-brief" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agent_id: string };
    const deskDir = join(h.repoPath, ".clobber", "agents", body.agent_id, "desk");
    expect(existsSync(deskDir)).toBe(false);

    const call = h.calls[h.calls.length - 1]!;
    expect(call.env?.["CLOBBER_DESK_DIR"]).toBe(deskDir);
  });
});
