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

  CREATE TABLE IF NOT EXISTS agents (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    role_id       TEXT    NOT NULL,
    label         TEXT,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id)      REFERENCES roles(id)      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agents_role      ON agents(role_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT    PRIMARY KEY,
    agent_id        TEXT,
    workspace_id    TEXT    NOT NULL,
    role_id         TEXT    NOT NULL,
    pid             INTEGER NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    transcript_path TEXT,
    FOREIGN KEY (agent_id)     REFERENCES agents(id)     ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id)      REFERENCES roles(id)      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_agent     ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON sessions(workspace_id, role_id)
    WHERE ended_at IS NULL;
`;

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export type { Database };
