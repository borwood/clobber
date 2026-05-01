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
`;

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export type { Database };
