import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  claudeRuntimeProvider,
  type RuntimeProvider,
  type RuntimeSpawnRequest,
} from "@clobber/runtime";
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
import { prepareSpawnContext } from "../src/spawn-context.ts";
import type { AgentSpawner } from "../src/types.ts";

interface SpawnRecord {
  readonly req: RuntimeSpawnRequest;
  exit(code: number | null): Promise<void>;
}

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly sessionTokens: ReturnType<typeof createSessionTokenStore>;
  readonly records: SpawnRecord[];
  readonly repoPath: string;
}

function turnProvider(): RuntimeProvider {
  return {
    ...claudeRuntimeProvider,
    id: "turn-test",
    capabilities: {
      processLifetime: "turn",
      livePromptInjection: false,
      interrupt: false,
      resume: true,
    },
    initialProviderThreadId(sessionId) {
      return `thread-${sessionId}`;
    },
    buildResumeRequest(opts) {
      return {
        ...this.buildSpawnRequest(opts),
        resume: true,
        providerThreadId: opts.providerThreadId,
      };
    },
  };
}

function buildHarness(runtimeProvider: RuntimeProvider): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionTokens = createSessionTokenStore(db);
  const records: SpawnRecord[] = [];
  let counter = 0;
  const spawner: AgentSpawner = (req) => {
    counter += 1;
    const stdin = new PassThrough();
    stdin.resume();
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    records.push({
      req,
      async exit(code) {
        resolveExit(code);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    });
    return {
      sessionId: req.sessionId,
      pid: 7000 + counter,
      exited,
      stdin,
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
    sessionTokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    runtimeProvider,
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/abs/cli.ts",
    dispatches: createTriggerDispatchStore(db),
  });
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-prep-spawn-ctx-"));
  return { server, db, workspaces, roles, workspaceRoles, sessions, sessionTokens, records, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

describe("prepareSpawnContext (#125) is the shared spawn/attach/resume seam", () => {
  it("is exported as a function from spawn-context.ts", () => {
    expect(typeof prepareSpawnContext).toBe("function");
  });

  it("spawn (attach) and resume share env/prompt/PATH layout, with documented asymmetries", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "first turn", label: "boot" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const spawnBody = spawnRes.json() as { session_id: string; pid: number };

    expect(h.records).toHaveLength(1);
    const attachReq = h.records[0]!.req;
    const attachEnv = attachReq.env;
    expect(attachEnv).toBeDefined();
    expect(attachEnv!["CLOBBER_API_BASE"]).toBe("http://test.invalid");
    expect(attachEnv!["CLOBBER_WORKSPACE_ID"]).toBe(ws.id);
    expect(attachEnv!["CLOBBER_ROLE"]).toBe("manager");
    expect(attachEnv!["CLOBBER_SESSION_ID"]).toBe(spawnBody.session_id);
    expect(typeof attachEnv!["CLOBBER_OFFICE_DIR"]).toBe("string");
    expect(attachEnv!["CLOBBER_OFFICE_DIR"]).toContain("/.clobber/offices/");
    expect(attachEnv!["CLOBBER_DESK_DIR"]).toBeDefined();
    expect(attachEnv!["CLOBBER_DESK_DIR"]).toContain("/.clobber/agents/");
    expect(attachEnv!["CLOBBER_DESK_DIR"]).toContain("/desk");
    expect(typeof attachEnv!["CLOBBER_SESSION_TOKEN"]).toBe("string");
    expect(attachEnv!["PATH"]!.startsWith(join(h.repoPath, ".clobber", "bin"))).toBe(true);

    expect(attachReq.prompt).toContain("[Previously in this office]");
    expect(attachReq.prompt.endsWith("first turn")).toBe(true);
    expect(attachReq.resume).toBeUndefined();
    expect(attachReq.providerThreadId).toBeUndefined();

    await h.records[0]!.exit(0);
    expect(h.sessions.get(spawnBody.session_id)!.ended_at).toBeUndefined();

    const resumeRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawnBody.session_id}/prompt`,
      payload: { prompt: "second turn" },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(h.records).toHaveLength(2);

    const resumeReq = h.records[1]!.req;
    const resumeEnv = resumeReq.env;
    expect(resumeEnv).toBeDefined();
    expect(resumeEnv!["CLOBBER_API_BASE"]).toBe(attachEnv!["CLOBBER_API_BASE"]);
    expect(resumeEnv!["CLOBBER_WORKSPACE_ID"]).toBe(attachEnv!["CLOBBER_WORKSPACE_ID"]);
    expect(resumeEnv!["CLOBBER_ROLE"]).toBe(attachEnv!["CLOBBER_ROLE"]);
    expect(resumeEnv!["CLOBBER_SESSION_ID"]).toBe(spawnBody.session_id);
    expect(resumeEnv!["CLOBBER_OFFICE_DIR"]).toBe(attachEnv!["CLOBBER_OFFICE_DIR"]);
    expect(resumeEnv!["PATH"]!.startsWith(join(h.repoPath, ".clobber", "bin"))).toBe(true);

    expect(resumeEnv!["CLOBBER_DESK_DIR"]).toBeUndefined();
    expect(typeof resumeEnv!["CLOBBER_SESSION_TOKEN"]).toBe("string");
    expect(resumeEnv!["CLOBBER_SESSION_TOKEN"]).not.toBe(attachEnv!["CLOBBER_SESSION_TOKEN"]);
    expect(h.sessionTokens.lookup(resumeEnv!["CLOBBER_SESSION_TOKEN"]!)?.session_id).toBe(
      spawnBody.session_id,
    );

    expect(resumeReq.prompt).toContain("[Previously in this office]");
    expect(resumeReq.prompt.endsWith("second turn")).toBe(true);
    expect(resumeReq.resume).toBe(true);
    expect(resumeReq.providerThreadId).toBe(`thread-${spawnBody.session_id}`);

    await h.records[1]!.exit(0);
    await teardown(h);
  });

  it("ephemeral role: attach skips office context but still passes the shared env shape", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "boot" },
    });
    expect(res.statusCode).toBe(200);

    expect(h.records).toHaveLength(1);
    const env = h.records[0]!.req.env;
    expect(env!["CLOBBER_OFFICE_DIR"]).toBeUndefined();
    expect(env!["CLOBBER_DESK_DIR"]).toBeDefined();
    expect(env!["CLOBBER_ROLE"]).toBe("worker");
    expect(h.records[0]!.req.prompt).toBe("do work");

    await teardown(h);
  });
});
