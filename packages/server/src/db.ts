import { Database } from "bun:sqlite";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at     INTEGER NOT NULL,
    session_id      TEXT    NOT NULL,
    hook_event_name TEXT    NOT NULL,
    payload_json    TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);

  CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    repo_path   TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_created ON workspaces(created_at DESC);

  CREATE TABLE IF NOT EXISTS roles (
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL UNIQUE,
    description       TEXT,
    permission_mode   TEXT,
    allowed_tools     TEXT,
    persistent        INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_roles_created ON roles(created_at DESC);

  CREATE TABLE IF NOT EXISTS workspace_role_ceilings (
    workspace_id    TEXT    NOT NULL,
    role_id         TEXT    NOT NULL,
    max_concurrent  INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, role_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id)      REFERENCES roles(id)      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_wrc_workspace ON workspace_role_ceilings(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_wrc_role      ON workspace_role_ceilings(role_id);
`;

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export type { Database };
