import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  claudeRuntimeProvider,
  type RuntimeProvider,
  type RuntimeSpawnRequest,
} from "@clobber/runtime";
import { createDriftStub, type DriftStub } from "./_drift-stub.ts";
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
import type { AgentSpawner } from "../src/types.ts";

export interface SpawnRecord {
  readonly req: RuntimeSpawnRequest;
  // Everything the server wrote to this child's stdin, in write order.
  readonly stdinChunks: string[];
  exit(code: number | null): Promise<void>;
}

export interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly roleVersions: ReturnType<typeof createRoleVersionStore>;
  readonly workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  readonly agents: ReturnType<typeof createAgentStore>;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly sessionTokens: ReturnType<typeof createSessionTokenStore>;
  readonly records: SpawnRecord[];
  readonly repoPath: string;
  readonly driftStub: DriftStub;
}

export function turnProvider(): RuntimeProvider {
  return {
    ...claudeRuntimeProvider,
    id: "turn-test",
    capabilities: {
      processLifetime: "turn",
      livePromptInjection: false,
      interrupt: false,
      resume: true,
      reconfigure: false,
      inSessionHabits: false,
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

// #491: roles created via `roles.create({ name: "worker" })` now get version rows
// via the shipped bundle (latestForRole fallback). Spawn uses embodyRole which
// falls back to latestForRole when no commit pin is set. No git setup needed in
// the harness for version-row-backed tests.
export function buildHarness(runtimeProvider: RuntimeProvider, opts?: { readonly installTimeoutMs?: number }): Harness {
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
    const stdinChunks: string[] = [];
    stdin.on("data", (chunk) => {
      stdinChunks.push(String(chunk));
    });
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    records.push({
      req,
      stdinChunks,
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
    sessionTokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    runtimeProvider,
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: driftStub.apiBase,
    cliEntry: "/abs/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    ...(opts?.installTimeoutMs !== undefined ? { installTimeoutMs: opts.installTimeoutMs } : {}),
  });
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-prep-spawn-ctx-"));
  return { server, db, workspaces, roles, roleVersions, workspaceRoles, agents, sessions, sessionTokens, records, repoPath, driftStub };
}

export async function teardown(h: Harness): Promise<void> {
  h.driftStub.stop();
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
}
