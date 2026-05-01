/**
 * Spike #3: end-to-end smoke against the *extracted* runtime + server.
 *
 * Verifies the actual @clobber/runtime spawnAgent + @clobber/server
 * createServer + EventStore work together as a real chain. The earlier
 * spikes used inline copies of the wire format; this one consumes the
 * library exports we'd ship.
 *
 * Asserts:
 *   - hook events arrive at /events keyed by the session_id we minted
 *   - /sessions rolls them up correctly (count, first/last seen, last event)
 *   - SQLite persistence: a fresh store sees the events on reopen
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgent } from "../packages/runtime/src/spawn-agent.ts";
import { createServer } from "../packages/server/src/server.ts";
import { createDatabase } from "../packages/server/src/db.ts";
import { createEventStore } from "../packages/server/src/event-store.ts";
import { createWorkspaceStore } from "../packages/server/src/workspace-store.ts";
import { createRoleStore } from "../packages/server/src/role-store.ts";
import { createWorkspaceRoleStore } from "../packages/server/src/workspace-role-store.ts";
import type { StoredEvent, SessionSummary } from "../packages/server/src/event-store.ts";

const PORT = 3302;
const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;
const DB_PATH = join(tmpdir(), `clobber-spike-runtime-${Date.now()}.db`);

const db = createDatabase(DB_PATH);
const store = createEventStore(db);
const workspaces = createWorkspaceStore(db);
const roles = createRoleStore(db);
const workspaceRoles = createWorkspaceRoleStore(db);
const server = createServer({
  store,
  workspaces,
  roles,
  workspaceRoles,
  spawner: () => ({ sessionId: "unused", pid: 0 }),
  hookUrl: HOOK_URL,
});
await server.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[spike3] server up at http://127.0.0.1:${PORT}, db=${DB_PATH}`);

const cwd = await mkdtemp(join(tmpdir(), "clobber-spike3-"));

const agent = spawnAgent({
  hookUrl: HOOK_URL,
  prompt: "Run the bash command `echo from-clobber-spike3` and then say done.",
  cwd,
  permissionMode: "bypassPermissions",
  allowedTools: ["Bash"],
  hookAsync: true,
});
console.log(`[spike3] spawned: pid=${agent.pid} session=${agent.sessionId}`);

const t0 = Date.now();
const code = await agent.exited;
console.log(`[spike3] claude exited code=${code} elapsed=${Date.now() - t0}ms`);

const eventsRes = await fetch(`http://127.0.0.1:${PORT}/events?session_id=${agent.sessionId}`);
const events = (await eventsRes.json()) as StoredEvent[];
console.log(`[spike3] events for session: ${events.length}`);
for (const ev of events) {
  console.log(`  [${ev.id}] ${ev.payload.hook_event_name}`);
}

const sessionsRes = await fetch(`http://127.0.0.1:${PORT}/sessions`);
const sessions = (await sessionsRes.json()) as SessionSummary[];
console.log(`[spike3] sessions: ${sessions.length}`);
for (const s of sessions) {
  console.log(
    `  ${s.session_id}  count=${s.event_count}  last=${s.last_event_name}  span=${s.last_seen_at - s.first_seen_at}ms`,
  );
}

const ourSession = sessions.find((s) => s.session_id === agent.sessionId);
console.log(`[spike3] session match: ${ourSession !== undefined}`);
console.log(`[spike3] event count > 0: ${events.length > 0}`);

await server.close();
db.close();

const reopenedDb = createDatabase(DB_PATH);
const reopened = createEventStore(reopenedDb);
const persisted = reopened.list({ session_id: agent.sessionId });
console.log(`[spike3] events after reopen: ${persisted.length} (should match above)`);
reopenedDb.close();

console.log("[spike3] done.");
process.exit(0);
