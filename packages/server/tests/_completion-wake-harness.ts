import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleTrigger } from "@clobber/shared";
import { createDriftStub, type DriftStub } from "./_drift-stub.ts";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore, type NotificationStore } from "../src/notification-store.ts";
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

// A live-injection harness for the completion-wake trigger subsystems
// (session-ended + worker-done). The default claude runtime provider supports
// livePromptInjection, so an idle target gets "injected" outcomes and its
// injected stdin is captured per spawn for assertion.
export interface SpawnLog {
  readonly sessionId: string;
  readonly prompt: string;
  readonly writes: Buffer[];
  resolveExit: (code: number | null) => void;
}

export interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  dispatches: ReturnType<typeof createTriggerDispatchStore>;
  notifications: NotificationStore;
  clock: TestClock;
  spawns: SpawnLog[];
  roleRepoDir: string;
  driftStub: DriftStub;
}

export function buildHarness(initial: Date): Harness {
  // #414 — `bootManager` PATCHes triggers, which now commits onto the role's git
  // pin; the write-side requires git-as-truth (a role repo) to be configured.
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-completion-wake-repo-"));
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
    spawns.push({ sessionId: req.sessionId, prompt: req.prompt!, writes, resolveExit });
    return { sessionId: req.sessionId, pid: pidCounter, exited, stdin, kill: () => {} };
  };

  const driftStub = createDriftStub();
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
    apiBase: driftStub.apiBase,
    cliEntry: "/dummy/cli.ts",
    dispatches,
    finalReportConsumerState,
    clock,
    roleRepoDir,
  });

  const notifications = createNotificationStore(db);
  return { server, db, tokens, dispatches, notifications, clock, spawns, roleRepoDir, driftStub };
}

export async function teardown(h: Harness): Promise<void> {
  h.driftStub.stop();
  await h.server.close();
  h.db.close();
  rmSync(h.roleRepoDir, { recursive: true, force: true });
}

export interface Booted {
  workspaceId: string;
  managerRoleId: string;
  managerAgentId: string;
  managerSessionId: string;
}

// Boot a manager and PATCH the given triggers onto its role so the scheduler
// registers it as a wake target for worker completions.
export async function bootManager(
  h: Harness,
  repoPath: string,
  triggers: RoleTrigger[],
): Promise<Booted> {
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

  // Workspace create (#694) already establishes the singleton manager agent —
  // wake it directly rather than spawning a second manager agent via /spawn.
  const managerAgentRow = h.db
    .prepare("SELECT id FROM agents WHERE workspace_id = ? AND role_id = ?")
    .get(ws.id, managerRow.id) as { id: string };
  const spawnRes = await h.server.inject({
    method: "POST",
    url: `/persistent-agents/${managerAgentRow.id}/wake`,
    payload: {},
  });
  if (spawnRes.statusCode !== 200) throw new Error(`boot: ${spawnRes.body}`);
  const boot = spawnRes.json() as { agent_id: string; session_id: string };
  const token = h.tokens.mint(boot.session_id);

  const patchRes = await h.server.inject({
    method: "PATCH",
    url: `/agent/roles/${managerRow.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { triggers },
  });
  if (patchRes.statusCode !== 200) throw new Error(`patch trigger: ${patchRes.body}`);

  return {
    workspaceId: ws.id,
    managerRoleId: managerRow.id,
    managerAgentId: boot.agent_id,
    managerSessionId: boot.session_id,
  };
}

export interface SpawnedWorker {
  agentId: string;
  sessionId: string;
  token: string;
}

export async function spawnWorker(
  h: Harness,
  workspaceId: string,
  label: string,
): Promise<SpawnedWorker> {
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

export async function postHook(
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

// Worker declares it finished via `clobber status done` (POST /agent/status).
export async function postStatus(
  h: Harness,
  worker: SpawnedWorker,
  state: "working" | "blocked" | "done",
  summary: string,
): Promise<void> {
  const res = await h.server.inject({
    method: "POST",
    url: "/agent/status",
    headers: { authorization: `Bearer ${worker.token}` },
    payload: { state, summary },
  });
  if (res.statusCode !== 200) throw new Error(`status ${state}: ${res.body}`);
}

// Decode the last serialized user-message injected into a spawn's stdin.
export function lastInjectedContent(spawn: SpawnLog): string {
  const text = Buffer.concat(spawn.writes).toString("utf8").trim();
  if (text.length === 0) return "";
  const lines = text.split("\n").filter((l) => l.length > 0);
  const parsed = JSON.parse(lines[lines.length - 1]!) as {
    message: { content: string };
  };
  return parsed.message.content;
}
