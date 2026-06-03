import type { Database } from "bun:sqlite";

// #491 — forward-only migration: drop the two operational version-pin columns
// that are now purely vestigial. The `role_versions` table and its audit FKs on
// `agent_status_log` and `role_contract_refusals` are intentionally kept; they
// are frozen provenance, not live resolution pointers.
//
// `roles.current_version_id` — the per-role "active version" pointer; live usage
//   was zero before this migration (all roles are commit-pinned).
// `sessions.role_version_id` — the per-session pin captured at spawn; all recent
//   sessions are commit-pinned, making this column permanently NULL on new rows.
//
// Both columns carry FK constraints, which SQLite cannot drop without a table
// rebuild. The rebuild copies all other columns verbatim and recreates the
// affected indexes so the rest of the schema is undisturbed.
export function migrateRoleVersionPinDrop(db: Database): void {
  if (!hasColumn(db, "roles", "current_version_id")) return;
  dropRoleCurrentVersionId(db);
  dropSessionRoleVersionId(db);
}

function dropRoleCurrentVersionId(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE roles_new (
      id                    TEXT    PRIMARY KEY,
      name                  TEXT    NOT NULL,
      description           TEXT,
      permission_mode       TEXT,
      effort                TEXT,
      model                 TEXT,
      persistent            INTEGER NOT NULL,
      workspace_id          TEXT,
      current_commit_branch TEXT,
      current_commit_sha    TEXT,
      created_at            INTEGER NOT NULL,
      UNIQUE (workspace_id, name),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    INSERT INTO roles_new (id, name, description, permission_mode, effort, model,
        persistent, workspace_id, current_commit_branch, current_commit_sha, created_at)
      SELECT id, name, description, permission_mode, effort, model,
        persistent, workspace_id, current_commit_branch, current_commit_sha, created_at
        FROM roles;
    DROP TABLE roles;
    ALTER TABLE roles_new RENAME TO roles;
    CREATE INDEX IF NOT EXISTS idx_roles_created ON roles(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_global_name
      ON roles(name) WHERE workspace_id IS NULL;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

function dropSessionRoleVersionId(db: Database): void {
  if (!hasColumn(db, "sessions", "role_version_id")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE sessions_new (
      id                       TEXT    PRIMARY KEY,
      agent_id                 TEXT,
      workspace_id             TEXT    NOT NULL,
      role_id                  TEXT    NOT NULL,
      role_commit_branch       TEXT,
      role_commit_sha          TEXT,
      runtime_provider         TEXT    NOT NULL DEFAULT 'claude',
      provider_thread_id       TEXT,
      wake_program             TEXT,
      label                    TEXT,
      pid                      INTEGER NOT NULL,
      started_at               INTEGER NOT NULL,
      ended_at                 INTEGER,
      transcript_path          TEXT,
      was_live_at_shutdown     INTEGER NOT NULL DEFAULT 0,
      composed_system_prompt   TEXT,
      model                    TEXT,
      effort                   TEXT,
      FOREIGN KEY (agent_id)     REFERENCES agents(id)     ON DELETE SET NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id)      REFERENCES roles(id)      ON DELETE CASCADE
    );
    INSERT INTO sessions_new (id, agent_id, workspace_id, role_id,
        role_commit_branch, role_commit_sha, runtime_provider, provider_thread_id,
        wake_program, label, pid, started_at, ended_at, transcript_path,
        was_live_at_shutdown, composed_system_prompt, model, effort)
      SELECT id, agent_id, workspace_id, role_id,
        role_commit_branch, role_commit_sha, runtime_provider, provider_thread_id,
        wake_program, label, pid, started_at, ended_at, transcript_path,
        was_live_at_shutdown, composed_system_prompt, model, effort
        FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_new RENAME TO sessions;
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace
      ON sessions(workspace_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_active
      ON sessions(workspace_id, role_id)
      WHERE ended_at IS NULL;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  return cols.includes(column);
}
