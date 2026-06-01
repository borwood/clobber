import type { Database } from "bun:sqlite";

// `sessions.model` and `sessions.effort` capture the resolved (effective)
// model and effort at spawn time — the override if one was supplied, otherwise
// the role's default. Persisted here so the session header can show what the
// session actually ran with rather than the role's current defaults, which can
// differ under per-dispatch overrides (#468).
export function migrateSessionModelEffort(db: Database): void {
  ensureColumn(db, "sessions", "model", "TEXT");
  ensureColumn(db, "sessions", "effort", "TEXT");
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
