import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
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
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { createTestClock, type TestClock } from "../src/clock.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

interface SpawnLog {
  readonly sessionId: string;
  readonly prompt: string;
  readonly writes: Buffer[];
  resolveExit: (code: number | null) => void;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  dispatches: ReturnType<typeof createTriggerDispatchStore>;
  clock: TestClock;
  spawns: SpawnLog[];
}

function buildHarness(initial: Date): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const dispatches = createTriggerDispatchStore(db);
  const finalReportConsumerState = createFinalReportConsumerStateStore(db);
  const clock = createTestClock(initial);

  const spawns: SpawnLog[] = [];
  let pidCounter = 9100;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    const stdin = new PassThrough();
    const writes: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(chunk));
    stdin.resume();
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    spawns.push({ sessionId: req.sessionId, prompt: req.prompt, writes, resolveExit });
    return { sessionId: req.sessionId, pid: pidCounter, exited, stdin, kill: () => {} };
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
    dispatches,
    finalReportConsumerState,
    clock,
  });

  return { server, db, tokens, dispatches, clock, spawns };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface Booted {
  workspaceId: string;
  managerRoleId: string;
  managerAgentId: string;
  managerSessionId: string;
}

// Boot a manager and PATCH a `session-ended` trigger onto its role so the
// scheduler registers it as a wake target for worker completions.
async function bootManagerWithTrigger(h: Harness, repoPath: string): Promise<Booted> {
  const wsRes = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: `ws-${repoPath}`, repo_path: repoPath },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };

  const spawnRes = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (spawnRes.statusCode !== 200) throw new Error(`boot: ${spawnRes.body}`);
  const boot = spawnRes.json() as { agent_id: string; session_id: string };
  const token = h.tokens.mint(boot.session_id);

  const patchRes = await h.server.inject({
    method: "PATCH",
    url: `/agent/roles/${managerRow.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { triggers: [{ kind: "session-ended" }] },
  });
  if (patchRes.statusCode !== 200) throw new Error(`patch trigger: ${patchRes.body}`);

  return {
    workspaceId: ws.id,
    managerRoleId: managerRow.id,
    managerAgentId: boot.agent_id,
    managerSessionId: boot.session_id,
  };
}

interface SpawnedWorker {
  agentId: string;
  sessionId: string;
  token: string;
}

async function spawnWorker(h: Harness, workspaceId: string, label: string): Promise<SpawnedWorker> {
  const workerRow = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", workspaceId) as { id: string };
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: workspaceId, role_id: workerRow.id, prompt: "assignment", label },
  });
  if (res.statusCode !== 200) throw new Error(`spawn worker: ${res.body}`);
  const body = res.json() as { agent_id: string; session_id: string };
  return { agentId: body.agent_id, sessionId: body.session_id, token: h.tokens.mint(body.session_id) };
}

async function postHook(
  h: Harness,
  sessionId: string,
  event: "Stop" | "SessionEnd",
): Promise<void> {
  const res = await h.server.inject({
    method: "POST",
    url: "/hook",
    payload: {
      session_id: sessionId,
      transcript_path: `/tmp/${sessionId}.jsonl`,
      cwd: "/tmp",
      permission_mode: "bypassPermissions",
      hook_event_name: event,
    },
  });
  if (res.statusCode !== 200) throw new Error(`hook ${event}: ${res.body}`);
}

// Decode the last serialized user-message injected into a spawn's stdin.
function lastInjectedContent(spawn: SpawnLog): string {
  const text = Buffer.concat(spawn.writes).toString("utf8").trim();
  if (text.length === 0) return "";
  const lines = text.split("\n").filter((l) => l.length > 0);
  const parsed = JSON.parse(lines[lines.length - 1]!) as {
    message: { content: string };
  };
  return parsed.message.content;
}

let repo: RepoFixture;
beforeEach(() => {
  repo = makeRepoFixture("clobber-session-ended-");
});
afterEach(() => {
  repo.cleanup();
});

describe("session-ended trigger — worker→manager completion signal", () => {
  it("(a) worker ends WITH a final-report → idle manager woken with rich payload (summary)", async () => {
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManagerWithTrigger(h, repo.path);

    // Manager goes idle so the wake injects rather than enqueues.
    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-42");
    const reportRes = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${worker.token}` },
      payload: { free_text: "shipped PR #999" },
    });
    expect(reportRes.statusCode).toBe(200);

    await postHook(h, worker.sessionId, "SessionEnd");

    const audit = h.dispatches.listForAgent(boot.managerAgentId);
    const sessionEnded = audit.filter((r) => r.trigger_kind === "session-ended");
    expect(sessionEnded.length).toBe(1);
    expect(sessionEnded[0]!.dispatch_outcome).toBe("injected");

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-42");
    expect(content).toContain("finished");
    expect(content).toContain("shipped PR #999");

    await teardown(h);
  });

  it("(b) worker ends WITHOUT a report (crash/kill) → idle manager woken with bare triage payload", async () => {
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManagerWithTrigger(h, repo.path);

    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-77");
    // No /agent/report — simulate crash/kill end.
    await postHook(h, worker.sessionId, "SessionEnd");

    const audit = h.dispatches.listForAgent(boot.managerAgentId);
    const sessionEnded = audit.filter((r) => r.trigger_kind === "session-ended");
    expect(sessionEnded.length).toBe(1);
    expect(sessionEnded[0]!.dispatch_outcome).toBe("injected");

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-77");
    expect(content).toContain("no report");
    expect(content).toContain("triage");

    await teardown(h);
  });

  it("(c) manager BUSY at completion → wakes enqueued, then flushed (coalesced) on next Stop", async () => {
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManagerWithTrigger(h, repo.path);
    // Manager stays busy (boot session registered busy by default).

    const w1 = await spawnWorker(h, boot.workspaceId, "issue-1");
    const w2 = await spawnWorker(h, boot.workspaceId, "issue-2");

    await postHook(h, w1.sessionId, "SessionEnd");
    await postHook(h, w2.sessionId, "SessionEnd");

    // Both completions are enqueued (manager busy) — never dropped.
    const queued = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "session-ended" && r.dispatch_outcome === "queued");
    expect(queued.length).toBe(2);

    // Nothing injected into the busy manager yet.
    expect(lastInjectedContent(h.spawns[0]!)).toBe("");

    // Manager finishes its turn → flush, coalescing both into one wake.
    await postHook(h, boot.managerSessionId, "Stop");

    const injected = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "session-ended" && r.dispatch_outcome === "injected");
    expect(injected.length).toBe(1);

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("2 workers");
    expect(content).toContain("issue-1");
    expect(content).toContain("issue-2");

    await teardown(h);
  });

  it("(d) spawn-pipeline child-exit (crash, non-zero) also wakes the manager", async () => {
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManagerWithTrigger(h, repo.path);

    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-crash");
    const workerSpawn = h.spawns.find((s) => s.sessionId === worker.sessionId)!;

    // Child process dies with a non-zero code, no SessionEnd hook ever arrives.
    workerSpawn.resolveExit(1);
    await new Promise((r) => setTimeout(r, 10));

    const sessionEnded = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "session-ended");
    expect(sessionEnded.length).toBe(1);
    expect(sessionEnded[0]!.dispatch_outcome).toBe("injected");

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-crash");
    expect(content).toContain("no report");

    await teardown(h);
  });
});
