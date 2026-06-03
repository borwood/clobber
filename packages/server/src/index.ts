import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeRuntimeProvider, codexRuntimeProvider, spawnAgent } from "@clobber/runtime";
import { createServer, type AgentSpawner } from "./server.ts";
import { createDatabase } from "./db.ts";
import { resolveDatabasePath } from "./db-path.ts";
import { resolvePort } from "@clobber/shared";
import { createEventStore } from "./event-store.ts";
import { createWorkspaceStore } from "./workspace-store.ts";
import { createRoleStore } from "./role-store.ts";
import { createRoleVersionStore } from "./role-version-store.ts";
import { createWorkspaceRoleStore } from "./workspace-role-store.ts";
import { createAgentStore } from "./agent-store.ts";
import { createSessionStore } from "./session-store.ts";
import { createWorkspaceSessionSummaries } from "./workspace-session-summaries.ts";
import { createSessionTokenStore } from "./session-token-store.ts";
import { createAgentStatusStore } from "./agent-status-store.ts";
import { createAgentStatusLogStore } from "./agent-status-log-store.ts";
import { createAgentQuestionStore } from "./agent-question-store.ts";
import { createAgentQuestionWaiter } from "./agent-question-waiter.ts";
import { createTriggerDispatchStore } from "./trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "./final-report-consumer.ts";
import { reapOrphanedSessions } from "./boot-reap.ts";

const PORT = resolvePort(process.env["CLOBBER_PORT"], 3370);
const API_BASE = `http://127.0.0.1:${PORT}`;
const HOOK_URL = `${API_BASE}/hook`;
const DB_PATH = resolveDatabasePath({
  envValue: process.env["CLOBBER_DB"],
  serverIndexUrl: import.meta.url,
  cwd: process.cwd(),
});
// #349 — the upstream role repo lives in the data dir beside the database. An
// in-memory database has no data dir, so git-as-truth stays off there.
const ROLE_REPO_DIR =
  DB_PATH === ":memory:" ? undefined : resolve(dirname(DB_PATH), "clobber-role-repo");

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, "../../cli/src/index.ts");
const runtimeProvider = process.env["CLOBBER_RUNTIME_PROVIDER"] === "codex"
  ? codexRuntimeProvider
  : claudeRuntimeProvider;

const spawner: AgentSpawner = (req) => {
  const agent = spawnAgent({
    hookUrl: req.hookUrl,
    prompt: req.prompt,
    ...(req.promptTag === undefined ? {} : { promptTag: req.promptTag }),
    cwd: req.cwd,
    ...(req.sessionId === undefined ? {} : { sessionId: req.sessionId }),
    ...(req.resume === true && req.providerThreadId !== undefined
      ? { resumeThreadId: req.providerThreadId }
      : {}),
    ...(req.pluginDirs === undefined ? {} : { pluginDirs: req.pluginDirs }),
    ...(req.permissionMode === undefined ? {} : { permissionMode: req.permissionMode }),
    ...(req.allowedTools === undefined ? {} : { allowedTools: req.allowedTools }),
    // The reasoning-depth + model knobs reach claude argv ONLY through here. Both
    // ride the RuntimeSpawnRequest but were never forwarded to spawnAgent, so the
    // role/spawn defaults were silently dropped before reaching the CLI — #423
    // wires model through, and effort alongside it (same gap, same fix).
    ...(req.effort === undefined ? {} : { effort: req.effort }),
    ...(req.model === undefined ? {} : { model: req.model }),
    ...(req.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: req.appendSystemPrompt }),
    ...(req.displayName === undefined ? {} : { displayName: req.displayName }),
    ...(req.command === undefined ? {} : { command: req.command }),
    ...(req.env === undefined ? {} : { env: req.env }),
    ...(req.settingSources === undefined
      ? {}
      : { settingSources: req.settingSources }),
  });
  return {
    sessionId: agent.sessionId,
    pid: agent.pid,
    exited: agent.exited,
    stdin: agent.stdin,
    kill: (signal) => {
      agent.child.kill(signal);
    },
    ...(agent.runtimeEvents === undefined ? {} : { runtimeEvents: agent.runtimeEvents }),
    ...(agent.startup === undefined ? {} : { startup: agent.startup }),
  };
};

const db = createDatabase(DB_PATH);
const store = createEventStore(db);
const workspaces = createWorkspaceStore(db);
const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
const workspaceRoles = createWorkspaceRoleStore(db);
const agents = createAgentStore(db);
const sessions = createSessionStore(db);
const sessionSummaries = createWorkspaceSessionSummaries(db);
const sessionTokens = createSessionTokenStore(db);
const agentStatuses = createAgentStatusStore(db);
const agentStatusLog = createAgentStatusLogStore(db);
const agentQuestions = createAgentQuestionStore(db);
const agentQuestionWaiter = createAgentQuestionWaiter();
const dispatches = createTriggerDispatchStore(db);
const finalReportConsumerState = createFinalReportConsumerStateStore(db);
reapOrphanedSessions({
  sessions,
  agents,
  roles,
  sessionTokens,
  agentQuestions,
  agentQuestionWaiter,
  runtimeProvider,
});
const app = createServer({
  db,
  store,
  workspaces,
  roles,
  roleVersions,
  workspaceRoles,
  agents,
  sessions,
  sessionSummaries,
  sessionTokens,
  agentStatuses,
  agentStatusLog,
  agentQuestions,
  agentQuestionWaiter,
  dispatches,
  finalReportConsumerState,
  runtimeProvider,
  spawner,
  hookUrl: HOOK_URL,
  apiBase: API_BASE,
  cliEntry: CLI_ENTRY,
  ...(ROLE_REPO_DIR === undefined ? {} : { roleRepoDir: ROLE_REPO_DIR }),
});
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`clobber-server listening on ${API_BASE} (db: ${DB_PATH})`);
