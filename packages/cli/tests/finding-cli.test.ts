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
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  managerSessionId: string;
  managerAgentId: string;
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
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-finding-cli-"));
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

  let pidCounter = 7000;
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
  const bootBody = bootRes.json() as { session_id: string; agent_id: string };
  const managerToken = tokens.mint(bootBody.session_id);
  const managerSession = sessions.get(bootBody.session_id);
  if (managerSession === null) throw new Error("manager session missing");
  const managerAgentId = managerSession.agent_id!;

  // Spawn a child session so we can seed a final-report for the reports list test.
  const childRes = await app.inject({
    method: "POST",
    url: "/agent/spawn",
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { role: "manager", prompt: "do work", label: "child-agent" },
  });
  const childBody = childRes.json() as { session_id: string };
  const childSession = sessions.get(childBody.session_id);
  if (childSession === null) throw new Error("child session missing");
  const childAgentId = childSession.agent_id!;

  agentStatusLog.append({
    agent_id: childAgentId,
    session_id: childBody.session_id,
    kind: "final-report",
    state: "final",
    summary: "well: shipped the feature",
    details: { well: "shipped the feature" },
  });

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    managerSessionId: bootBody.session_id,
    managerAgentId,
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

describe("clobber CLI — finding (#167)", () => {
  it("`finding <summary>` appends a kind=finding row and exits 0", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["finding", "manager spotted a disk-usage spike near prompt-module seeding"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const rows = harness.db
      .prepare(
        "SELECT * FROM agent_status_log WHERE session_id = ? AND kind = 'finding' ORDER BY id ASC",
      )
      .all(harness.managerSessionId) as Array<{ kind: string; summary: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.summary.includes("disk-usage spike"))).toBe(true);
  });

  it("is repeatable — multiple findings in one session all persist", async () => {
    const s1 = captureStreams();
    const s2 = captureStreams();
    await run({ argv: ["finding", "alpha observation"], env: env(), stdout: s1.stdout, stderr: s1.stderr });
    await run({ argv: ["finding", "beta observation"], env: env(), stdout: s2.stdout, stderr: s2.stderr });

    const rows = harness.db
      .prepare(
        "SELECT * FROM agent_status_log WHERE session_id = ? AND kind = 'finding' ORDER BY id ASC",
      )
      .all(harness.managerSessionId) as Array<{ summary: string }>;
    const summaries = rows.map((r) => r.summary);
    expect(summaries.some((s) => s.includes("alpha observation"))).toBe(true);
    expect(summaries.some((s) => s.includes("beta observation"))).toBe(true);
  });

  it("exits 2 and prints usage when summary is missing", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["finding"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/summary/i);
  });
});

describe("clobber CLI — reports list includes findings (#167)", () => {
  it("lists findings alongside final-reports, each labeled by kind", async () => {
    // Seed a finding for the manager session directly so we have one of each kind.
    harness.agentStatusLog.append({
      agent_id: harness.managerAgentId,
      session_id: harness.managerSessionId,
      kind: "finding",
      state: "finding",
      summary: "this is a seeded finding for the reports list test",
    });

    const s = captureStreams();
    const code = await run({
      argv: ["reports", "list"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const out = s.out();
    expect(out).toContain("finding");
    expect(out).toContain("final-report");
    expect(out).toContain("seeded finding for the reports list test");
    expect(out).toContain("shipped the feature");
  });

  it("list --json includes kind field on each entry", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["reports", "list", "--json"],
      env: env(),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(s.out()) as {
      reports: Array<{ kind: string; summary: string }>;
    };
    const kinds = parsed.reports.map((r) => r.kind);
    expect(kinds).toContain("finding");
    expect(kinds).toContain("final-report");
  });
});
