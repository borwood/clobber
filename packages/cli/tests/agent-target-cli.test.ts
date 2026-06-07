import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
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

interface KillRecord {
  readonly sessionId: string;
  readonly signal: NodeJS.Signals;
}

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  killCalls: KillRecord[];
  resumePrompts: Array<string | undefined>;
  // Live, labelled children (spawned through /agent/spawn so they register).
  alphaId: string; // unique label "alpha"
  betaId: string; // targeted by full session id
  gammaId: string; // targeted by session-id prefix
  dupAId: string; // label "dup" (collides with dupB)
  dupBId: string; // label "dup"
  // An ended, resumable child labelled "revive".
  reviveId: string;
  repoPath: string;
}

let harness: Harness;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-agent-target-cli-"));
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager")!;
  const workerRole = roles.findInWorkspace(ws.id, "worker")!;
  // Room for the five live children below.
  workspaceRoles.setCeiling(ws.id, workerRole.id, 10);

  const killCalls: KillRecord[] = [];
  const resumePrompts: Array<string | undefined> = [];
  let pidCounter = 9000;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.resume === true) resumePrompts.push(req.prompt);
    const sessionId = req.sessionId ?? randomUUID();
    return {
      sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: (signal) => {
        killCalls.push({ sessionId, signal });
      },
    };
  };

  // Manager session (the caller): wildcard CLI, may list/kill/resume/transcript.
  const managerAgent = agents.create({ workspace_id: ws.id, role_id: managerRole.id });
  const managerSessionId = randomUUID();
  sessions.create({
    id: managerSessionId,
    agent_id: managerAgent.id,
    workspace_id: ws.id,
    role_id: managerRole.id,
    pid: 1,
  });
  const managerToken = tokens.mint(managerSessionId);

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
    spawner,
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

  async function spawnChild(label: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/spawn",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { role: "worker", prompt: "work", label },
    });
    if (res.statusCode !== 200) {
      throw new Error(`spawn ${label} failed: ${res.statusCode} ${res.body}`);
    }
    return (res.json() as { session_id: string }).session_id;
  }

  const alphaId = await spawnChild("alpha");
  const betaId = await spawnChild("beta");
  const gammaId = await spawnChild("gamma");
  const dupAId = await spawnChild("dup");
  const dupBId = await spawnChild("dup");

  // An ended, resumable child labelled "revive".
  const reviveAgent = agents.create({
    workspace_id: ws.id,
    role_id: workerRole.id,
    label: "revive",
  });
  const reviveId = randomUUID();
  sessions.create({
    id: reviveId,
    agent_id: reviveAgent.id,
    workspace_id: ws.id,
    role_id: workerRole.id,
    provider_thread_id: reviveId,
    label: "revive",
    pid: 2,
  });
  sessions.markEnded(reviveId);

  harness = {
    app,
    db,
    baseUrl,
    managerToken,
    killCalls,
    resumePrompts,
    alphaId,
    betaId,
    gammaId,
    dupAId,
    dupBId,
    reviveId,
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

function runCli(s: ReturnType<typeof captureStreams>, argv: string[]): Promise<number> {
  return run({
    argv,
    env: {
      CLOBBER_API_BASE: harness.baseUrl,
      CLOBBER_SESSION_TOKEN: harness.managerToken,
    },
    stdout: s.stdout,
    stderr: s.stderr,
  });
}

describe("clobber CLI — agent-target resolver", () => {
  it("resolves a unique label to its session id (kill alpha)", async () => {
    const s = captureStreams();
    const code = await runCli(s, ["kill", "alpha"]);
    expect(code).toBe(0);
    expect(harness.killCalls.some((k) => k.sessionId === harness.alphaId)).toBe(true);
  });

  it("resolves a full session id even when a label collides (kill <beta-id>)", async () => {
    const s = captureStreams();
    const code = await runCli(s, ["kill", harness.betaId]);
    expect(code).toBe(0);
    expect(harness.killCalls.some((k) => k.sessionId === harness.betaId)).toBe(true);
  });

  it("resolves a session-id prefix (kill <gamma-prefix>)", async () => {
    const s = captureStreams();
    const code = await runCli(s, ["kill", harness.gammaId.slice(0, 8)]);
    expect(code).toBe(0);
    expect(harness.killCalls.some((k) => k.sessionId === harness.gammaId)).toBe(true);
  });

  it("rejects with 'no such agent' when nothing matches", async () => {
    const s = captureStreams();
    const code = await runCli(s, ["kill", "ghost-no-match"]);
    expect(code).toBe(2);
    expect(s.err()).toMatch(/no such agent/i);
  });

  it("rejects an ambiguous label and prints label : session-id pairs", async () => {
    const s = captureStreams();
    const before = harness.killCalls.length;
    const code = await runCli(s, ["kill", "dup"]);
    expect(code).toBe(2);
    expect(s.err()).toMatch(/multiple agents match/i);
    expect(s.err()).toContain(harness.dupAId);
    expect(s.err()).toContain(harness.dupBId);
    expect(s.err()).toMatch(/dup\s*:/);
    // Ambiguity rejects before any kill is issued.
    expect(harness.killCalls.length).toBe(before);
  });

  it("resolves an ended session by label for resume", async () => {
    const s = captureStreams();
    const code = await runCli(s, ["resume", "revive", "--prompt", "back to work"]);
    expect(code).toBe(0);
    expect(s.out()).toMatch(harness.reviveId);
    expect(harness.resumePrompts.some((p) => p?.includes("back to work"))).toBe(true);
  });

  it("does not resolve a live agent's label for resume (ended-only)", async () => {
    const s = captureStreams();
    const code = await runCli(s, ["resume", "dup"]);
    expect(code).toBe(2);
    expect(s.err()).toMatch(/no such agent/i);
  });
});
