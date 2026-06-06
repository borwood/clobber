import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { codexRuntimeProvider, type RuntimeProvider } from "@clobber/runtime";
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
import type { AgentSpawner, AgentSpawnRequest } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";

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

function buildHarness(opts: { readonly runtimeProvider?: RuntimeProvider } = {}): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
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
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/abs/cli/index.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    ...(opts.runtimeProvider === undefined
      ? {}
      : { runtimeProvider: opts.runtimeProvider }),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, sessionTokens, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

describe("POST /spawn — manager bundle materialization", () => {
  it("materializes the manager plugin under .clobber/roles/manager and threads token+env+pluginDir", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "boot" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; pid: number };

    const pluginDir = join(repoPath, ".clobber", "roles", "manager");
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "whoami", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "spawn", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pluginDir, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(repoPath, ".clobber", "bin", "clobber"))).toBe(true);
    expect(existsSync(join(repoPath, ".claude"))).toBe(false);

    const hooksRaw = readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8");
    expect(hooksRaw).toContain("http://127.0.0.1:3300/hook");
    expect(hooksRaw).not.toContain("__CLOBBER_HOOK_URL__");

    const session = h.sessions.get(body.session_id);
    expect(session).not.toBeNull();
    expect(session!.pid).toBe(8123);

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.sessionId).toBe(body.session_id);
    expect(call.cwd).toBe(repoPath);
    expect(call.env).toBeDefined();
    expect(call.env!["CLOBBER_API_BASE"]).toBe(DRIFT_STUB_API_BASE);
    expect(call.env!["CLOBBER_SESSION_ID"]).toBe(body.session_id);
    expect(call.env!["CLOBBER_WORKSPACE_ID"]).toBe(ws.id);
    expect(call.env!["CLOBBER_ROLE"]).toBe("manager");
    const passedToken = call.env!["CLOBBER_SESSION_TOKEN"];
    expect(typeof passedToken).toBe("string");
    expect(h.sessionTokens.lookup(passedToken!)?.session_id).toBe(body.session_id);

    expect(call.pluginDirs).toEqual([pluginDir]);

    const path = call.env!["PATH"]!;
    expect(path.startsWith(join(repoPath, ".clobber", "bin"))).toBe(true);

    const shim = readFileSync(join(repoPath, ".clobber", "bin", "clobber"), "utf8");
    expect(shim).toContain("/abs/cli/index.ts");

    expect(typeof call.appendSystemPrompt).toBe("string");
    expect(call.appendSystemPrompt!).toMatch(/Manager/);

    await teardown(h);
  });

  it("codex provider passes role instructions as prompt prefix and keeps clobber CLI env", async () => {
    const h = buildHarness({ runtimeProvider: codexRuntimeProvider });
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "boot" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; pid: number };

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.sessionId).toBe(body.session_id);
    expect(call.pluginDirs).toBeUndefined();
    expect(call.command).toMatchObject({
      bin: "codex",
      stdoutEventFormat: "codex-jsonl",
    });
    expect(call.command!.args).toEqual([
      "exec",
      "--json",
      "--cd",
      repoPath,
      call.prompt!,
    ]);

    expect(call.prompt).toContain("<clobber-role-system-prompt>");
    expect(call.prompt).toMatch(/Manager/);
    expect(call.prompt).toContain("[Previously in this office]");
    expect(call.prompt!.endsWith("go")).toBe(true);

    expect(call.env!["CLOBBER_API_BASE"]).toBe(DRIFT_STUB_API_BASE);
    expect(call.env!["CLOBBER_SESSION_ID"]).toBe(body.session_id);
    expect(call.env!["CLOBBER_WORKSPACE_ID"]).toBe(ws.id);
    expect(call.env!["CLOBBER_ROLE"]).toBe("manager");
    const passedToken = call.env!["CLOBBER_SESSION_TOKEN"];
    expect(typeof passedToken).toBe("string");
    expect(h.sessionTokens.lookup(passedToken!)?.session_id).toBe(body.session_id);
    expect(call.env!["PATH"]!.startsWith(join(repoPath, ".clobber", "bin"))).toBe(true);
    expect(existsSync(join(repoPath, ".clobber", "bin", "clobber"))).toBe(true);

    await teardown(h);
  });

  it("returns 422 and does not spawn when the role has no current version (#21)", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
    const role = h.roles.create({ name: "no-bundle-here", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "boot" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; role: string };
    expect(body.error).toMatch(/current version/i);
    expect(body.role).toBe("no-bundle-here");

    expect(existsSync(join(repoPath, ".claude"))).toBe(false);
    expect(existsSync(join(repoPath, ".clobber"))).toBe(false);
    expect(h.calls).toHaveLength(0);

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
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "boot" },
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
