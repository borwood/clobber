import { Database } from "bun:sqlite";
import { migrateRoleVersions } from "./role-version-migration.ts";
import { migrateSessionLabel } from "./session-label-migration.ts";
import { migrateWorkspaceConfig } from "./workspace-config-migration.ts";
import { migrateSessionRuntime } from "./session-runtime-migration.ts";
import { migrateAgentQuestions } from "./agent-question-migration.ts";
import { migrateRoleEffort } from "./role-effort-migration.ts";
import { migrateSessionWasLive } from "./session-was-live-migration.ts";
import { migrateSessionComposedPrompt } from "./session-composed-prompt-migration.ts";
import { migrateRoleAllowedToolsColumnDrop } from "./role-allowed-tools-column-drop-migration.ts";
import { migrateRoleContractVersion } from "./role-contract-version-migration.ts";
import { migrateRoleCommitPin } from "./role-commit-pin-migration.ts";
import { migrateWorkspaceTheme } from "./theme-migration.ts";

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
    id                    TEXT    PRIMARY KEY,
    name                  TEXT    NOT NULL UNIQUE,
    repo_path             TEXT    NOT NULL,
    setting_sources       TEXT    NOT NULL DEFAULT '["user","project","local"]',
    role_edit_policy      TEXT    NOT NULL DEFAULT '{"forbidden_keys":["hooks","permission_mode"]}',
    trigger_overrides     TEXT    NOT NULL DEFAULT '{}',
    final_report_callback TEXT    NOT NULL DEFAULT '{"kind":"noop"}',
    spawn_worktree        TEXT    NOT NULL DEFAULT '{"kind":"off"}',
    file_size_policy      TEXT    NOT NULL DEFAULT '{"kind":"on","max_lines":300}',
    manager_skill_policy  TEXT    NOT NULL DEFAULT '{"allow_self_grant":false,"allowed_skills":[]}',
    theme                 TEXT    NOT NULL DEFAULT '{"mode":"dark","accent":"emerald"}',
    created_at            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_created ON workspaces(created_at DESC);

  CREATE TABLE IF NOT EXISTS roles (
    id                 TEXT    PRIMARY KEY,
    name               TEXT    NOT NULL,
    description        TEXT,
    permission_mode    TEXT,
    effort             TEXT,
    persistent         INTEGER NOT NULL,
    workspace_id       TEXT,
    current_version_id TEXT,
    current_commit_branch TEXT,
    current_commit_sha    TEXT,
    created_at         INTEGER NOT NULL,
    UNIQUE (workspace_id, name),
    FOREIGN KEY (workspace_id)       REFERENCES workspaces(id)     ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_roles_created   ON roles(created_at DESC);

  CREATE TABLE IF NOT EXISTS role_versions (
    id                        TEXT    PRIMARY KEY,
    role_id                   TEXT    NOT NULL,
    version                   INTEGER NOT NULL,
    framing                   TEXT    NOT NULL DEFAULT '',
    system_prompt             TEXT    NOT NULL,
    skills_json               TEXT    NOT NULL,
    allowed_tools_json        TEXT    NOT NULL,
    allowed_cli_commands_json TEXT    NOT NULL DEFAULT '[]',
    hooks_json                TEXT    NOT NULL,
    triggers_json             TEXT    NOT NULL DEFAULT '[]',
    seed_refs_json            TEXT    NOT NULL DEFAULT '[]',
    wake_programs_json        TEXT    NOT NULL DEFAULT '[]',
    default_wake_program      TEXT,
    contract_version          INTEGER NOT NULL DEFAULT 1,
    created_at                INTEGER NOT NULL,
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
    role_commit_branch TEXT,
    role_commit_sha    TEXT,
    runtime_provider  TEXT NOT NULL DEFAULT 'claude',
    provider_thread_id TEXT,
    wake_program    TEXT,
    label           TEXT,
    pid             INTEGER NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    transcript_path TEXT,
    was_live_at_shutdown INTEGER NOT NULL DEFAULT 0,
    composed_system_prompt TEXT,
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

  CREATE TABLE IF NOT EXISTS tool_tokens (
    token             TEXT    PRIMARY KEY,
    target_session_id TEXT    NOT NULL,
    tool              TEXT    NOT NULL,
    args_json         TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (target_session_id, tool),
    FOREIGN KEY (target_session_id) REFERENCES sessions(id) ON DELETE CASCADE
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

  CREATE TABLE IF NOT EXISTS agent_message_tokens (
    token                 TEXT    PRIMARY KEY,
    originator_session_id TEXT    NOT NULL,
    recipient_session_id  TEXT    NOT NULL,
    message_id            TEXT    NOT NULL,
    created_at            INTEGER NOT NULL,
    redeemed_at           INTEGER,
    FOREIGN KEY (originator_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_session_id)  REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_message_tokens_recipient
    ON agent_message_tokens(recipient_session_id);

  CREATE TABLE IF NOT EXISTS agent_questions (
    id             TEXT    PRIMARY KEY,
    session_id     TEXT    NOT NULL,
    questions_json TEXT    NOT NULL,
    status         TEXT    NOT NULL,
    answer         TEXT,
    asked_at       INTEGER NOT NULL,
    answered_at    INTEGER,
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

  CREATE TABLE IF NOT EXISTS role_contract_refusals (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id              TEXT    NOT NULL,
    agent_id                  TEXT,
    role_id                   TEXT    NOT NULL,
    role_name                 TEXT    NOT NULL,
    role_version_id           TEXT    NOT NULL,
    authored_contract_version INTEGER NOT NULL,
    engine_contract_version   INTEGER NOT NULL,
    created_at                INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_role_contract_refusals_workspace
    ON role_contract_refusals(workspace_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS final_report_consumer_state (
    workspace_id     TEXT    PRIMARY KEY,
    last_consumed_id INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS materialized_role_cache (
    sha              TEXT    PRIMARY KEY,
    contract_json    TEXT    NOT NULL,
    contract_version INTEGER NOT NULL,
    created_at       INTEGER NOT NULL
  );
`;

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // contract_version must be added before migrateRoleVersions runs: that migration
  // constructs a RoleVersionStore whose prepared INSERT references contract_version,
  // so on an existing pre-#236 database the store's prepare throws unless the column
  // already exists. Fresh databases get it from SCHEMA; existing ones get it here.
  migrateRoleContractVersion(db);
  migrateRoleVersions(db);
  migrateSessionLabel(db);
  migrateSessionRuntime(db);
  migrateWorkspaceConfig(db);
  migrateAgentQuestions(db);
  migrateRoleEffort(db);
  migrateSessionWasLive(db);
  migrateSessionComposedPrompt(db);
  migrateRoleAllowedToolsColumnDrop(db);
  migrateRoleCommitPin(db);
  migrateWorkspaceTheme(db);
  return db;
}

export type { Database };
