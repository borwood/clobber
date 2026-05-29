import type { Database } from "bun:sqlite";

// Stamps `contract_version` onto pre-#236 `role_versions` rows. New databases
// get the column via the CREATE TABLE in db.ts; this is purely for older
// databases that pre-date it. The `DEFAULT 1` backfills every existing row to
// the contract version current when the column was introduced — `1`, the only
// contract that existed before the stamp, frozen here as history (NOT tracking
// the live `ENGINE_CONTRACT_VERSION`, which a later release may bump). Fresh
// rows authored after this point are stamped explicitly by the role-version
// store with the engine's current contract version.
export function migrateRoleContractVersion(db: Database): void {
  ensureColumn(
    db,
    "role_versions",
    "contract_version",
    "INTEGER NOT NULL DEFAULT 1",
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
