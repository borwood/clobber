/**
 * Spike #4: drive an agent purely through the HTTP API.
 *
 * Asserts that POSTing to /spawn (with the real runtime wired in) launches
 * claude and that hook events flow back into /events for the returned
 * session_id. This is the loop the UI will drive.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgent } from "../packages/runtime/src/spawn-agent.ts";
import { createServer, type AgentSpawner } from "../packages/server/src/server.ts";
import { createDatabase } from "../packages/server/src/db.ts";
import { createEventStore } from "../packages/server/src/event-store.ts";
import { createWorkspaceStore } from "../packages/server/src/workspace-store.ts";
import { createRoleStore } from "../packages/server/src/role-store.ts";
import { createWorkspaceRoleStore } from "../packages/server/src/workspace-role-store.ts";
import { createAgentStore } from "../packages/server/src/agent-store.ts";
import { createSessionStore } from "../packages/server/src/session-store.ts";
import type { StoredEvent } from "../packages/server/src/event-store.ts";

const PORT = 3303;
const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;
const BASE = `http://127.0.0.1:${PORT}`;

const db = createDatabase(":memory:");
const store = createEventStore(db);
const workspaces = createWorkspaceStore(db);
const roles = createRoleStore(db);
const workspaceRoles = createWorkspaceRoleStore(db);
const agents = createAgentStore(db);
const sessions = createSessionStore(db);

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

const server = createServer({
  store,
  workspaces,
  roles,
  workspaceRoles,
  agents,
  sessions,
  spawner,
  hookUrl: HOOK_URL,
});
await server.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[spike4] server up at ${BASE}`);

const cwd = await mkdtemp(join(tmpdir(), "clobber-spike4-"));

const ws = workspaces.create({ name: "spike4", repo_path: cwd });
const role = roles.create({
  name: "spike-runner",
  persistent: false,
  permission_mode: "bypassPermissions",
  allowed_tools: ["Bash"],
});
workspaceRoles.setCeiling(ws.id, role.id, 1);

const t0 = Date.now();
const spawnRes = await fetch(`${BASE}/spawn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    workspace_id: ws.id,
    role_id: role.id,
    prompt: "Run the bash command `echo from-spike4` and then say done.",
  }),
});

if (!spawnRes.ok) {
  console.error("[spike4] /spawn failed:", spawnRes.status, await spawnRes.text());
  process.exit(1);
}

const { agent_id, session_id, pid } = (await spawnRes.json()) as {
  agent_id: string;
  session_id: string;
  pid: number;
};
const sessionId = session_id;
console.log(`[spike4] /spawn returned agent=${agent_id} session=${sessionId} pid=${pid}`);

let events: StoredEvent[] = [];
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const r = await fetch(`${BASE}/events?session_id=${sessionId}`);
  events = (await r.json()) as StoredEvent[];
  const hasStop = events.some((e) => e.payload.hook_event_name === "Stop");
  if (hasStop) break;
  await Bun.sleep(200);
}

const elapsed = Date.now() - t0;
console.log(`[spike4] received ${events.length} events in ${elapsed}ms`);
for (const ev of events) {
  console.log(`  [${ev.id}] ${ev.payload.hook_event_name}`);
}

const stopFound = events.some((e) => e.payload.hook_event_name === "Stop");
console.log(`[spike4] saw Stop event: ${stopFound}`);
console.log(`[spike4] all events tagged with our sessionId: ${events.every((e) => e.payload.session_id === sessionId)}`);

await server.close();
db.close();
console.log("[spike4] done.");
process.exit(stopFound ? 0 : 1);
