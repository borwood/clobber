import type { Database } from "bun:sqlite";
import { loadRoleBundle } from "@clobber/runtime";
import { snapshotShippedBundle } from "./role-version-snapshot.ts";
import { createRoleVersionStore } from "./role-version-store.ts";

export function migrateRoleVersions(db: Database): void {
  ensureColumn(db, "roles", "workspace_id", "TEXT");
  ensureColumn(db, "roles", "current_version_id", "TEXT");
  ensureColumn(db, "sessions", "role_version_id", "TEXT");
  backfillRoleVersions(db);
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

interface UnversionedRow {
  id: string;
  name: string;
  allowed_tools: string | null;
}

function backfillRoleVersions(db: Database): void {
  const versions = createRoleVersionStore(db);
  const rows = db
    .prepare(
      "SELECT id, name, allowed_tools FROM roles WHERE current_version_id IS NULL",
    )
    .all() as UnversionedRow[];
  if (rows.length === 0) return;

  const setVersion = db.prepare(
    "UPDATE roles SET current_version_id = ? WHERE id = ?",
  );
  const dropOrphan = db.prepare("DELETE FROM roles WHERE id = ?");

  for (const row of rows) {
    const loaded = loadRoleBundle(row.name);
    if (loaded === null) {
      dropOrphan.run(row.id);
      continue;
    }
    const allowedTools =
      row.allowed_tools === null
        ? []
        : (JSON.parse(row.allowed_tools) as readonly string[]);
    const snapshot = snapshotShippedBundle({ loaded, allowedTools });
    const version = versions.create({
      role_id: row.id,
      version: 1,
      ...snapshot,
    });
    setVersion.run(version.id, row.id);
  }
}
