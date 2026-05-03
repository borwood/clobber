import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "@clobber/runtime";
import { createServer, type AgentSpawner } from "./server.ts";
import { createDatabase } from "./db.ts";
import { createEventStore } from "./event-store.ts";
import { createWorkspaceStore } from "./workspace-store.ts";
import { createRoleStore } from "./role-store.ts";
import { createWorkspaceRoleStore } from "./workspace-role-store.ts";
import { createAgentStore } from "./agent-store.ts";
import { createSessionStore } from "./session-store.ts";
import { createWorkspaceSessionSummaries } from "./workspace-session-summaries.ts";
import { createSessionTokenStore } from "./session-token-store.ts";
import { reapOrphanedSessions } from "./boot-reap.ts";

const PORT = 3300;
const API_BASE = `http://127.0.0.1:${PORT}`;
const HOOK_URL = `${API_BASE}/hook`;
const envDb = process.env["CLOBBER_DB"];
const DB_PATH = envDb && envDb.length > 0 ? envDb : "./clobber.db";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, "../../cli/src/index.ts");

const spawner: AgentSpawner = (req) => {
  const agent = spawnAgent({
    hookUrl: req.hookUrl,
    prompt: req.prompt,
    cwd: req.cwd,
    ...(req.sessionId === undefined ? {} : { sessionId: req.sessionId }),
    ...(req.pluginDirs === undefined ? {} : { pluginDirs: req.pluginDirs }),
    ...(req.permissionMode === undefined ? {} : { permissionMode: req.permissionMode }),
    ...(req.allowedTools === undefined ? {} : { allowedTools: req.allowedTools }),
    ...(req.env === undefined ? {} : { env: req.env }),
  });
  return {
    sessionId: agent.sessionId,
    pid: agent.pid,
    exited: agent.exited,
    stdin: agent.stdin,
  };
};

const db = createDatabase(DB_PATH);
const store = createEventStore(db);
const workspaces = createWorkspaceStore(db);
const roles = createRoleStore(db);
const workspaceRoles = createWorkspaceRoleStore(db);
const agents = createAgentStore(db);
const sessions = createSessionStore(db);
const sessionSummaries = createWorkspaceSessionSummaries(db);
const sessionTokens = createSessionTokenStore(db);
reapOrphanedSessions({ sessions, agents, roles, sessionTokens });
const app = createServer({
  store,
  workspaces,
  roles,
  workspaceRoles,
  agents,
  sessions,
  sessionSummaries,
  sessionTokens,
  spawner,
  hookUrl: HOOK_URL,
  apiBase: API_BASE,
  cliEntry: CLI_ENTRY,
});
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`clobber-server listening on ${API_BASE} (db: ${DB_PATH})`);
