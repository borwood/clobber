import type { Database } from "bun:sqlite";

// #349 git-as-truth — adds the commit-ref pin columns alongside the pre-existing
// row pointers. A role/session is pinned EITHER by a `role_versions` row id
// (the pre-#349 store) OR by a commit into the upstream role repo. New databases
// get these via the CREATE TABLE in db.ts; this backfills older databases. The
// columns are nullable with no default — a row carries one pin kind or the other,
// never a placeholder.
export function migrateRoleCommitPin(db: Database): void {
  ensureColumn(db, "roles", "current_commit_branch", "TEXT");
  ensureColumn(db, "roles", "current_commit_sha", "TEXT");
  ensureColumn(db, "sessions", "role_commit_branch", "TEXT");
  ensureColumn(db, "sessions", "role_commit_sha", "TEXT");
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
