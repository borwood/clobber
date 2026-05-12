import type { Database } from "bun:sqlite";

// Adds workspaces.setting_sources to pre-existing databases. New databases
// get the column via the CREATE TABLE statement in db.ts; this is purely
// for older databases that pre-date the column. Backfills the column with
// the same default the schema declares, so existing workspaces get the
// full claude default (user,project,local).
export function migrateWorkspaceConfig(db: Database): void {
  ensureColumn(
    db,
    "workspaces",
    "setting_sources",
    `TEXT NOT NULL DEFAULT '["user","project","local"]'`,
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
