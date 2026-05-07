import { Database } from "bun:sqlite";
import { migrateRoleVersions } from "./role-version-migration.ts";
import { migrateSessionLabel } from "./session-label-migration.ts";

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
    FOREIGN KEY (workspace_id)       REFERENCES workspaces(id)     ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_roles_created   ON roles(created_at DESC);

  CREATE TABLE IF NOT EXISTS role_versions (
    id                 TEXT    PRIMARY KEY,
    role_id            TEXT    NOT NULL,
    version            INTEGER NOT NULL,
    system_prompt      TEXT    NOT NULL,
    skills_json        TEXT    NOT NULL,
    allowed_tools_json TEXT    NOT NULL,
    hooks_json         TEXT    NOT NULL,
    triggers_json      TEXT    NOT NULL DEFAULT '[]',
    created_at         INTEGER NOT NULL,
    UNIQUE (role_id, version),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_role_versions_role ON role_versions(role_id, version DESC);

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
    role_version_id TEXT,
    label           TEXT,
    pid             INTEGER NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    transcript_path TEXT,
    FOREIGN KEY (agent_id)        REFERENCES agents(id)        ON DELETE SET NULL,
    FOREIGN KEY (workspace_id)    REFERENCES workspaces(id)    ON DELETE CASCADE,
    FOREIGN KEY (role_id)         REFERENCES roles(id)         ON DELETE CASCADE,
    FOREIGN KEY (role_version_id) REFERENCES role_versions(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_agent     ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON sessions(workspace_id, role_id)
    WHERE ended_at IS NULL;

  CREATE TABLE IF NOT EXISTS session_tokens (
    token       TEXT    PRIMARY KEY,
    session_id  TEXT    NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_statuses (
    session_id    TEXT    PRIMARY KEY,
    state         TEXT    NOT NULL,
    summary       TEXT    NOT NULL,
    details_json  TEXT,
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_status_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,
    event_id      INTEGER,
    kind          TEXT    NOT NULL,
    state         TEXT    NOT NULL,
    summary       TEXT    NOT NULL,
    details_json  TEXT,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id)   REFERENCES events(id)   ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_status_log_agent
    ON agent_status_log(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_status_log_session
    ON agent_status_log(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_status_log_kind
    ON agent_status_log(kind, created_at DESC);

  CREATE TABLE IF NOT EXISTS agent_questions (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT    NOT NULL,
    question      TEXT    NOT NULL,
    options_json  TEXT,
    status        TEXT    NOT NULL,
    answer        TEXT,
    asked_at      INTEGER NOT NULL,
    answered_at   INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_questions_session_status
    ON agent_questions(session_id, status, asked_at DESC);

  CREATE TABLE IF NOT EXISTS trigger_dispatches (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id         TEXT    NOT NULL,
    role_id              TEXT    NOT NULL,
    agent_id             TEXT    NOT NULL,
    trigger_kind         TEXT    NOT NULL,
    trigger_payload_json TEXT    NOT NULL,
    fired_at             INTEGER NOT NULL,
    dispatch_outcome     TEXT    NOT NULL,
    session_id           TEXT,
    error                TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id)      REFERENCES roles(id)      ON DELETE CASCADE,
    FOREIGN KEY (agent_id)     REFERENCES agents(id)     ON DELETE CASCADE,
    FOREIGN KEY (session_id)   REFERENCES sessions(id)   ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trigger_dispatches_agent
    ON trigger_dispatches(agent_id, fired_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trigger_dispatches_workspace
    ON trigger_dispatches(workspace_id, fired_at DESC);
`;

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrateRoleVersions(db);
  migrateSessionLabel(db);
  return db;
}

export type { Database };
