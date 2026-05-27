import type { Database } from "bun:sqlite";

// `sessions.composed_system_prompt` holds the full clobber-composed
// `appendSystemPrompt` the agent was spawned with on this wake (#253) —
// distinct from `role_versions.system_prompt`, which is the template. A
// persistent agent re-composes its prompt every wake, so capturing it per
// session row preserves the deltas (assignment context, standing-order drift)
// for the audit surface. Existing rows predate capture and stay NULL.
export function migrateSessionComposedPrompt(db: Database): void {
  ensureColumn(db, "sessions", "composed_system_prompt", "TEXT");
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (cols.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
