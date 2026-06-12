/**
 * CLI test for `clobber reply` — verifies the command prints an intelligible
 * confirmation line (delivered vs queued) rather than raw JSON (#638 AC5).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "@clobber/server/server.ts";
import { createDatabase } from "@clobber/server/db.ts";
import { createEventStore } from "@clobber/server/event-store.ts";
import { createWorkspaceStore } from "@clobber/server/workspace-store.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { createRoleVersionStore } from "@clobber/server/role-version-store.ts";
import { createWorkspaceRoleStore } from "@clobber/server/workspace-role-store.ts";
import { createAgentStore } from "@clobber/server/agent-store.ts";
import { createSessionStore } from "@clobber/server/session-store.ts";
import { createWorkspaceSessionSummaries } from "@clobber/server/workspace-session-summaries.ts";
import { createSessionTokenStore } from "@clobber/server/session-token-store.ts";
import { createAgentStatusStore } from "@clobber/server/agent-status-store.ts";
import { createAgentStatusLogStore } from "@clobber/server/agent-status-log-store.ts";
import { createAgentQuestionStore } from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { seedWorkspaceRoles } from "@clobber/server/seed-workspace-roles.ts";
import { DRIFT_STUB_API_BASE } from "@clobber/server/_drift-stub.ts";
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  managerSessionId: string;
  workerToken: string;
  workerSessionId: string;
  workerAgentId: string;
  repoPath: string;
}

let h: Harness;

function makeSpawner(): AgentSpawner {
  return (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    stdin.resume();
    return {
      sessionId: req.sessionId,
      pid: 8000,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-reply-cli-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const app = createServer({
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
    spawner: makeSpawner(),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);

  const managerRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: {
      workspace_id: ws.id,
      role_id: roles.findInWorkspace(ws.id, "manager")!.id,
      prompt: "boot",
      label: "mgr",
    },
  });
  const managerBody = managerRes.json() as { session_id: string; agent_id: string };
  const managerToken = tokens.mint(managerBody.session_id);

  const workerRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: {
      workspace_id: ws.id,
      role_id: roles.findInWorkspace(ws.id, "worker")!.id,
      prompt: "boot",
      label: "wkr",
    },
  });
  const workerBody = workerRes.json() as { session_id: string; agent_id: string };
  const workerToken = tokens.mint(workerBody.session_id);

  h = {
    app,
    db,
    baseUrl,
    managerToken,
    managerSessionId: managerBody.session_id,
    workerToken,
    workerSessionId: workerBody.session_id,
    workerAgentId: workerBody.agent_id,
    repoPath,
  };
});

afterAll(async () => {
  await h.app.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
});

function captureStreams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (c: Buffer) => out.push(c));
  stderr.on("data", (c: Buffer) => err.push(c));
  return {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    out: () => Buffer.concat(out).toString("utf8"),
    err: () => Buffer.concat(err).toString("utf8"),
  };
}

async function openThread(): Promise<string> {
  const send = await h.app.inject({
    method: "POST",
    url: "/agent/messages",
    headers: { authorization: `Bearer ${h.managerToken}` },
    payload: { recipient_agent_id: h.workerAgentId, body: "status?" },
  });
  expect(send.statusCode).toBe(200);
  return (send.json() as { token: string }).token;
}

describe("clobber reply — CLI output", () => {
  it("prints a human-readable confirmation line (not raw JSON) on success", async () => {
    const replyToken = await openThread();

    // Idle the manager session so the reply is injected immediately.
    await h.app.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: h.managerSessionId,
        transcript_path: "/tmp/t.jsonl",
        cwd: "/r",
        permission_mode: "default" as const,
        hook_event_name: "Stop" as const,
      },
    });

    const s = captureStreams();
    const code = await run({
      argv: ["reply", replyToken, "migration was clean"],
      env: {
        CLOBBER_API_BASE: h.baseUrl,
        CLOBBER_SESSION_TOKEN: h.workerToken,
      },
      stdout: s.stdout,
      stderr: s.stderr,
    });

    expect(code).toBe(0);
    const out = s.out();

    // Must be a human-readable line, not raw JSON.
    // Old code: `{"replied_at":...}` — bare JSON, no action context.
    // New code: a line containing the action (injected/queued/spawned/…).
    expect(out).not.toMatch(/^\{/);
    expect(out.toLowerCase()).toMatch(/injected|queued|spawned|resumed|replied/);
    expect(s.err()).toBe("");
  });
});
