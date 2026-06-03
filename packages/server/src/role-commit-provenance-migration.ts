import type { Database } from "bun:sqlite";

// Adds role_commit_sha and role_commit_branch as first-class columns to
// agent_status_log (#486). Captures commit-pinned session role identity
// alongside the version-pinned role_version_id added by #221.
// Existing rows predate provenance capture and stay NULL.
export function migrateRoleCommitProvenance(db: Database): void {
  ensureColumn(db, "agent_status_log", "role_commit_sha", "role_commit_sha", "TEXT");
  ensureColumn(db, "agent_status_log", "role_commit_branch", "role_commit_branch", "TEXT");
}

function ensureColumn(
  db: Database,
  table: string,
  checkName: string,
  sqlName: string,
  type: string,
): void {
  const cols = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (cols.includes(checkName)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${sqlName} ${type}`);
}
