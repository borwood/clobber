import { spawnAgent } from "@clobber/runtime";
import { createServer, type AgentSpawner } from "./server.ts";
import { createEventStore } from "./event-store.ts";

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

const store = createEventStore(DB_PATH);
const app = createServer({ store, spawner, hookUrl: HOOK_URL });
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`clobber-server listening on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
