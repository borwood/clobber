import type { Database } from "bun:sqlite";

// `sessions.model_override` and `sessions.effort_override` record the explicit
// per-session dials (spawn-time override or live reconfigure). Resume resolves
// override ?? role default, so a set dial survives wakes while an unset one
// keeps tracking the role (#468).
//
// Must run AFTER migrateRoleVersionPinDrop: that migration rebuilds `sessions`
// from a fixed column list (and fires even on fresh databases, because
// migrateRoleVersions re-creates the legacy pin columns first), so any session
// column added before it is silently dropped — the #591 ordering class.
export function migrateSessionDialOverrides(db: Database): void {
  ensureColumn(db, "sessions", "model_override", "TEXT");
  ensureColumn(db, "sessions", "effort_override", "TEXT");
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
