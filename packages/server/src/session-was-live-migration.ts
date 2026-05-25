import type { Database } from "bun:sqlite";

// `sessions.was_live_at_shutdown` marks sessions that boot reconciliation found
// still active from a previous server process — they were live when clobber
// last closed, so the UI surfaces them as resume candidates. Existing rows
// default to 0 (not flagged); the flag is set at boot and cleared on resume.
export function migrateSessionWasLive(db: Database): void {
  ensureColumn(db, "sessions", "was_live_at_shutdown", "INTEGER NOT NULL DEFAULT 0");
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
