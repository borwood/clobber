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
import { createEventStore } from "../packages/server/src/event-store.ts";
import type { StoredEvent } from "../packages/server/src/event-store.ts";

const PORT = 3303;
const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;
const BASE = `http://127.0.0.1:${PORT}`;

const store = createEventStore(":memory:");

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

const server = createServer({ store, spawner, hookUrl: HOOK_URL });
await server.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[spike4] server up at ${BASE}`);

const cwd = await mkdtemp(join(tmpdir(), "clobber-spike4-"));

const t0 = Date.now();
const spawnRes = await fetch(`${BASE}/spawn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    prompt: "Run the bash command `echo from-spike4` and then say done.",
    cwd,
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash"],
  }),
});

if (!spawnRes.ok) {
  console.error("[spike4] /spawn failed:", spawnRes.status, await spawnRes.text());
  process.exit(1);
}

const { sessionId, pid } = (await spawnRes.json()) as { sessionId: string; pid: number };
console.log(`[spike4] /spawn returned session=${sessionId} pid=${pid}`);

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
store.close();
console.log("[spike4] done.");
process.exit(stopFound ? 0 : 1);
