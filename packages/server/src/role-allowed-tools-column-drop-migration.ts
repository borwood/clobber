import type { Database } from "bun:sqlite";
import { createRoleVersionStore } from "./role-version-store.ts";

// Bug #272: roles.allowed_tools was being live-read at spawn while edits flowed
// into role_versions.allowed_tools_json. Drop the column so role_versions is the
// single source of truth. Before dropping, fold any drift (legacy column value
// differs from the current version) into a fresh version, protecting users
// whose role row diverged from the version they last edited.
export function migrateRoleAllowedToolsColumnDrop(db: Database): void {
  if (!hasColumn(db, "roles", "allowed_tools")) return;

  reconcileDrift(db);

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE roles_new (
      id                 TEXT    PRIMARY KEY,
      name               TEXT    NOT NULL,
      description        TEXT,
      permission_mode    TEXT,
      effort             TEXT,
      persistent         INTEGER NOT NULL,
      workspace_id       TEXT,
      current_version_id TEXT,
      created_at         INTEGER NOT NULL,
      UNIQUE (workspace_id, name),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    INSERT INTO roles_new (id, name, description, permission_mode, effort, persistent, workspace_id, current_version_id, created_at)
      SELECT id, name, description, permission_mode, effort, persistent, workspace_id, current_version_id, created_at FROM roles;
    DROP TABLE roles;
    ALTER TABLE roles_new RENAME TO roles;
    CREATE INDEX IF NOT EXISTS idx_roles_created   ON roles(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_roles_workspace ON roles(workspace_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_global_name
      ON roles(name) WHERE workspace_id IS NULL;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

interface DriftRow {
  role_id: string;
  current_version_id: string | null;
  legacy_allowed_tools: string | null;
  version_allowed_tools_json: string | null;
}

function reconcileDrift(db: Database): void {
  const rows = db
    .prepare(
      `SELECT r.id AS role_id,
              r.current_version_id AS current_version_id,
              r.allowed_tools AS legacy_allowed_tools,
              v.allowed_tools_json AS version_allowed_tools_json
         FROM roles r
         LEFT JOIN role_versions v ON v.id = r.current_version_id
         WHERE r.allowed_tools IS NOT NULL
           AND r.current_version_id IS NOT NULL`,
    )
    .all() as DriftRow[];
  if (rows.length === 0) return;

  const versions = createRoleVersionStore(db);
  const setCurrent = db.prepare(
    "UPDATE roles SET current_version_id = ? WHERE id = ?",
  );
  const maxVersionStmt = db.prepare(
    "SELECT COALESCE(MAX(version), 0) AS v FROM role_versions WHERE role_id = ?",
  );

  for (const row of rows) {
    const legacy = JSON.stringify(
      JSON.parse(row.legacy_allowed_tools as string) as unknown,
    );
    const current = row.version_allowed_tools_json;
    if (current === null) continue;
    const normalizedCurrent = JSON.stringify(
      JSON.parse(current) as unknown,
    );
    if (normalizedCurrent === legacy) continue;

    const sourceVersion = versions.get(row.current_version_id as string);
    if (sourceVersion === null) continue;
    const nextVersion =
      (maxVersionStmt.get(row.role_id) as { v: number }).v + 1;
    const created = versions.create({
      role_id: row.role_id,
      version: nextVersion,
      framing: sourceVersion.framing,
      system_prompt: sourceVersion.system_prompt,
      skills_json: sourceVersion.skills_json,
      allowed_tools_json: legacy,
      allowed_cli_commands_json: sourceVersion.allowed_cli_commands_json,
      hooks_json: sourceVersion.hooks_json,
      triggers_json: sourceVersion.triggers_json,
      seed_refs_json: sourceVersion.seed_refs_json,
      wake_programs_json: sourceVersion.wake_programs_json,
      default_wake_program: sourceVersion.default_wake_program,
    });
    setCurrent.run(created.id, row.role_id);
  }
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  return cols.includes(column);
}
