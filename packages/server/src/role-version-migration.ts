import type { Database } from "bun:sqlite";
import { loadRoleBundle } from "@clobber/runtime";
import { snapshotShippedBundle } from "./role-version-snapshot.ts";
import { createRoleVersionStore } from "./role-version-store.ts";
import { backfillUnseededWorkspaces } from "./seed-workspace-roles.ts";

export function migrateRoleVersions(db: Database): void {
  ensureColumn(db, "roles", "workspace_id", "TEXT");
  ensureColumn(db, "roles", "current_version_id", "TEXT");
  ensureColumn(db, "sessions", "role_version_id", "TEXT");
  ensureColumn(db, "role_versions", "triggers_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(
    db,
    "role_versions",
    "allowed_cli_commands_json",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  dropLegacyGlobalUniqueName(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_roles_workspace ON roles(workspace_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_global_name
      ON roles(name) WHERE workspace_id IS NULL;
  `);
  backfillRoleVersions(db);
  backfillCliAllowLists(db);
  backfillUnseededWorkspaces(db);
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

function dropLegacyGlobalUniqueName(db: Database): void {
  const indexes = db
    .prepare("PRAGMA index_list(roles)")
    .all() as Array<{ name: string; unique: number; origin: string }>;
  const hasLegacyUnique = indexes.some(
    (i) => i.unique === 1 && i.origin === "u" && hasOnlyNameColumn(db, i.name),
  );
  if (!hasLegacyUnique) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE roles_new (
      id                 TEXT    PRIMARY KEY,
      name               TEXT    NOT NULL,
      description        TEXT,
      permission_mode    TEXT,
      allowed_tools      TEXT,
      persistent         INTEGER NOT NULL,
      workspace_id       TEXT,
      current_version_id TEXT,
      created_at         INTEGER NOT NULL,
      UNIQUE (workspace_id, name),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    INSERT INTO roles_new (id, name, description, permission_mode, allowed_tools, persistent, workspace_id, current_version_id, created_at)
      SELECT id, name, description, permission_mode, allowed_tools, persistent, workspace_id, current_version_id, created_at FROM roles;
    DROP TABLE roles;
    ALTER TABLE roles_new RENAME TO roles;
    CREATE INDEX IF NOT EXISTS idx_roles_created   ON roles(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_roles_workspace ON roles(workspace_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_global_name
      ON roles(name) WHERE workspace_id IS NULL;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

function hasOnlyNameColumn(db: Database, indexName: string): boolean {
  const info = db
    .prepare(`PRAGMA index_info(${JSON.stringify(indexName)})`)
    .all() as Array<{ name: string }>;
  return info.length === 1 && info[0]!.name === "name";
}

interface UnversionedRow {
  id: string;
  name: string;
  allowed_tools: string | null;
}

interface CliAllowListBackfillRow {
  version_id: string;
  role_name: string;
}

// Existing role_versions rows pre-date the allowed_cli_commands_json column;
// the column default is '[]' (default-deny). For shipped roles we can recover
// the intended allow-list from the matching bundle's manifest. Forked or
// unknown roles stay at '[]' — they had no enforcement before, but now must
// be re-edited to opt into commands.
function backfillCliAllowLists(db: Database): void {
  const rows = db
    .prepare(
      `SELECT rv.id AS version_id, r.name AS role_name
         FROM role_versions rv
         JOIN roles r ON r.id = rv.role_id
         WHERE rv.allowed_cli_commands_json = '[]'`,
    )
    .all() as CliAllowListBackfillRow[];
  if (rows.length === 0) return;
  const update = db.prepare(
    "UPDATE role_versions SET allowed_cli_commands_json = ? WHERE id = ?",
  );
  for (const row of rows) {
    const loaded = loadRoleBundle(row.role_name);
    if (loaded === null) continue;
    update.run(
      JSON.stringify([...loaded.manifest.allowedCliCommands]),
      row.version_id,
    );
  }
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
