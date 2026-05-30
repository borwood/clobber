import type { Database } from "bun:sqlite";

// Adds the per-workspace theme column to pre-existing databases (#369). Fresh
// databases get it from the CREATE TABLE in db.ts; this backfills older rows
// with the same dark/emerald default the schema declares, so workspaces created
// before theming load as dark/emerald rather than failing to parse.
export function migrateWorkspaceTheme(db: Database): void {
  ensureColumn(
    db,
    "workspaces",
    "theme",
    `TEXT NOT NULL DEFAULT '{"mode":"dark","accent":"emerald"}'`,
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
