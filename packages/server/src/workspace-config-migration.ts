import type { Database } from "bun:sqlite";

// Adds workspace config columns to pre-existing databases. New databases
// get the columns via the CREATE TABLE statement in db.ts; this is purely
// for older databases that pre-date the columns. Backfills each column
// with the same default the schema declares.
export function migrateWorkspaceConfig(db: Database): void {
  ensureColumn(
    db,
    "workspaces",
    "setting_sources",
    `TEXT NOT NULL DEFAULT '["user","project","local"]'`,
  );
  ensureColumn(
    db,
    "workspaces",
    "wake_prompt",
    `TEXT NOT NULL DEFAULT 'You have been woken without a specific task. Review your office notes, then summarise where you left off and what (if anything) needs your attention next.'`,
  );
  ensureColumn(
    db,
    "workspaces",
    "role_edit_policy",
    `TEXT NOT NULL DEFAULT '{"forbidden_keys":["hooks","permission_mode"]}'`,
  );
  ensureColumn(
    db,
    "workspaces",
    "trigger_overrides",
    `TEXT NOT NULL DEFAULT '{}'`,
  );
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
