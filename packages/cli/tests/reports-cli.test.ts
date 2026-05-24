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
import {
  createAgentStatusLogStore,
  type AgentStatusLogStore,
} from "@clobber/server/agent-status-log-store.ts";
import { createAgentQuestionStore } from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { SessionStore } from "@clobber/server/session-store.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { run, runWithExit } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  childSessionId: string;
  agentStatusLog: AgentStatusLogStore;
  sessions: SessionStore;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-reports-cli-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const agentStatusLog = createAgentStatusLogStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const managerRole = roles.create({ name: "manager", persistent: true });
  workspaceRoles.setCeiling(ws.id, managerRole.id, 5);

  let pidCounter = 8000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };

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
    agentStatusLog,
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRole.id, prompt: "boot", label: "boot" },
  });
  const bootBody = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(bootBody.session_id);

  const childRes = await app.inject({
    method: "POST",
    url: "/agent/spawn",
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { role: "manager", prompt: "do work", label: "issue-42 worker" },
  });
  const childBody = childRes.json() as { session_id: string };
  const childSession = sessions.get(childBody.session_id);
  if (childSession === null) throw new Error("child session missing");
  const childAgentId = childSession.agent_id;
  if (childAgentId === undefined) throw new Error("child agent id missing");

  // Seed two final-report rows for the child session's agent: a structured
  // one and a free-text one. The newest (free-text) should sort first in list,
  // and `show` returns the latest for that session.
  agentStatusLog.append({
    agent_id: childAgentId,
    session_id: childBody.session_id,
    kind: "final-report",
    state: "final",
    summary: "well: tests landed clean | badly: spent too long re-reading the issue",
    details: {
      well: "tests landed clean",
      badly: "spent too long re-reading the issue",
      useful: "a worked example of the transcript store join",
    },
  });

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    childSessionId: childBody.session_id,
    agentStatusLog,
    sessions,
    repoPath,
  };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
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

const env = () => ({
  CLOBBER_API_BASE: harness.baseUrl,
  CLOBBER_SESSION_TOKEN: harness.managerToken,
});

describe("clobber CLI — reports", () => {
  it("list renders one row per final-report with role, state, summary, session id", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["reports", "list"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain(harness.childSessionId);
    expect(out).toContain("manager");
    expect(out).toContain("issue-42 worker");
    expect(out).toContain("tests landed clean");
  });

  it("list --json emits the structured report summaries", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["reports", "list", "--json"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      reports: Array<{
        session_id: string;
        role: string;
        label?: string;
        state: string;
        summary: string;
        created_at: number;
      }>;
    };
    expect(parsed.reports).toHaveLength(1);
    const r = parsed.reports[0]!;
    expect(r.session_id).toBe(harness.childSessionId);
    expect(r.role).toBe("manager");
    expect(r.label).toBe("issue-42 worker");
    expect(r.state).toBe("final");
    expect(typeof r.created_at).toBe("number");
  });

  it("show <session-id> prints the full structured well/badly/useful", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["reports", "show", harness.childSessionId],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("tests landed clean");
    expect(out).toContain("spent too long re-reading the issue");
    expect(out).toContain("a worked example of the transcript store join");
  });

  it("show --json returns the full report payload", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["reports", "show", harness.childSessionId, "--json"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      session_id: string;
      role: string;
      report: { well?: string; badly?: string; useful?: string; free_text?: string };
    };
    expect(parsed.session_id).toBe(harness.childSessionId);
    expect(parsed.report.well).toBe("tests landed clean");
    expect(parsed.report.useful).toBe("a worked example of the transcript store join");
  });

  it("show exits 1 for a session with no final report", async () => {
    const s = captureStreams();
    const code = await runWithExit({
      argv: ["reports", "show", "00000000-0000-0000-0000-000000000000"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(1);
    expect(s.err()).toMatch(/not found/i);
  });

  it("exits 2 with usage when no subcommand is given", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["reports"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/list|show/i);
  });

  it("show exits 2 with usage when no session id is given", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["reports", "show"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/session/i);
  });
});
