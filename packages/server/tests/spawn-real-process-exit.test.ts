import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
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
import type { AgentSpawner } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";

/**
 * #11: an agent process exiting out-of-band (claude `/exit`, external SIGKILL,
 * crash without SessionEnd hook) must still flip its sessions row to ended_at.
 * Earlier coverage relied on a deferred-exit stub — here we spawn an actual
 * child process and kill it from the OS to exercise the real `child.on('exit')`
 * wiring end-to-end.
 */

function realProcessSpawner(): AgentSpawner {
  return (req) => {
    if (req.sessionId === undefined) throw new Error("sessionId required");
    const child = nodeSpawn("sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid === undefined) throw new Error("failed to spawn sleep: no pid");
    if (child.stdin === null) throw new Error("failed to spawn sleep: stdin is null");
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    return {
      sessionId: req.sessionId,
      pid: child.pid,
      stdin: child.stdin,
      exited,
      kill: (signal) => child.kill(signal),
    };
  };
}

function buildHarness(opts: { ceiling?: number } = {}) {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-real-exit-"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: "manager", persistent: false });
  workspaceRoles.setCeiling(ws.id, role.id, opts.ceiling === undefined ? 2 : opts.ceiling);

  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions: createRoleVersionStore(db),
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: realProcessSpawner(),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
  });

  return { server, db, repoPath, ws, role, sessions, agents };
}

async function teardown(h: { server: ReturnType<typeof createServer>; db: ReturnType<typeof createDatabase>; repoPath: string }): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}

async function waitFor<T>(predicate: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val !== null) return val;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: ${label} not satisfied within ${timeoutMs}ms`);
}

describe("real-process external exit reaping (issue #11)", () => {
  it("SIGKILL on the child PID flips sessions.ended_at within 500ms", async () => {
    const h = buildHarness();
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: h.ws.id, role_id: h.role.id, prompt: "live", label: "real-kill" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; agent_id: string; pid: number };

    expect(h.sessions.get(body.session_id)!.ended_at).toBeUndefined();

    process.kill(body.pid, "SIGKILL");

    const ended = await waitFor(
      () => {
        const s = h.sessions.get(body.session_id);
        return s !== null && s.ended_at !== undefined ? s : null;
      },
      500,
      "sessions.ended_at set after SIGKILL",
    );
    expect(typeof ended.ended_at).toBe("number");
    expect(h.agents.get(body.agent_id)).toBeNull();

    await teardown(h);
  });

  it("frees role capacity after external exit so a follow-up spawn fits", async () => {
    const h = buildHarness({ ceiling: 1 });
    const { ws, role } = h;

    const first = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "live", label: "real-kill" },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { session_id: string; pid: number };

    const blocked = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "blocked", label: "real-kill" },
    });
    expect(blocked.statusCode).toBe(403);

    process.kill(firstBody.pid, "SIGKILL");

    await waitFor(
      () => {
        const s = h.sessions.get(firstBody.session_id);
        return s !== null && s.ended_at !== undefined ? s : null;
      },
      500,
      "first session ended after SIGKILL",
    );

    const second = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "follow-up", label: "real-kill" },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { session_id: string; pid: number };
    expect(secondBody.session_id).not.toBe(firstBody.session_id);

    process.kill(secondBody.pid, "SIGKILL");
    await waitFor(
      () => {
        const s = h.sessions.get(secondBody.session_id);
        return s !== null && s.ended_at !== undefined ? s : null;
      },
      500,
      "second session ended after SIGKILL (cleanup)",
    );

    await teardown(h);
  });
});
