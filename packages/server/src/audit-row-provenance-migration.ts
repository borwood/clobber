import type { Database } from "bun:sqlite";

// Adds commit, branch, and role_version_id as first-class columns to
// agent_status_log (#221). transcript_anchor lives in details_json, not here.
// Existing rows predate provenance capture and stay NULL.
export function migrateAuditRowProvenance(db: Database): void {
  // `commit` is a SQL reserved word; quote it in the DDL but check by bare name.
  ensureColumn(db, "agent_status_log", "commit", '"commit"', "TEXT");
  ensureColumn(db, "agent_status_log", "branch", "branch", "TEXT");
  ensureColumn(db, "agent_status_log", "role_version_id", "role_version_id", "TEXT");
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
