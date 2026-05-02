import { spawnAgent } from "@clobber/runtime";
import { createServer, type AgentSpawner } from "./server.ts";
import { createDatabase } from "./db.ts";
import { createEventStore } from "./event-store.ts";
import { createWorkspaceStore } from "./workspace-store.ts";
import { createRoleStore } from "./role-store.ts";
import { createWorkspaceRoleStore } from "./workspace-role-store.ts";
import { createAgentStore } from "./agent-store.ts";
import { createSessionStore } from "./session-store.ts";

const PORT = 3300;
const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;
const envDb = process.env["CLOBBER_DB"];
const DB_PATH = envDb && envDb.length > 0 ? envDb : "./clobber.db";

const spawner: AgentSpawner = (req) => {
  const agent = spawnAgent({
    hookUrl: req.hookUrl,
    prompt: req.prompt,
    cwd: req.cwd,
    ...(req.sessionId === undefined ? {} : { sessionId: req.sessionId }),
    ...(req.permissionMode === undefined ? {} : { permissionMode: req.permissionMode }),
    ...(req.allowedTools === undefined ? {} : { allowedTools: req.allowedTools }),
  });
  return { sessionId: agent.sessionId, pid: agent.pid };
};

const db = createDatabase(DB_PATH);
const store = createEventStore(db);
const workspaces = createWorkspaceStore(db);
const roles = createRoleStore(db);
const workspaceRoles = createWorkspaceRoleStore(db);
const agents = createAgentStore(db);
const sessions = createSessionStore(db);
const app = createServer({
  store,
  workspaces,
  roles,
  workspaceRoles,
  agents,
  sessions,
  spawner,
  hookUrl: HOOK_URL,
});
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`clobber-server listening on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
