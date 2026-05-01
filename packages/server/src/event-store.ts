import { Database } from "bun:sqlite";
import { HookPayloadSchema, type HookPayload } from "@clobber/shared";

export interface StoredEvent {
  readonly id: number;
  readonly received_at: number;
  readonly payload: HookPayload;
}

export interface ListFilter {
  readonly session_id?: string;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly event_count: number;
  readonly last_event_name: string;
}

export interface EventStore {
  append(payload: HookPayload): StoredEvent;
  list(filter?: ListFilter): StoredEvent[];
  listSessions(): SessionSummary[];
  close(): void;
}

interface Row {
  id: number;
  received_at: number;
  session_id: string;
  hook_event_name: string;
  payload_json: string;
}

export function createEventStore(path: string): EventStore {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at     INTEGER NOT NULL,
      session_id      TEXT    NOT NULL,
      hook_event_name TEXT    NOT NULL,
      payload_json    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
  `);

  const insertStmt = db.prepare(
    "INSERT INTO events (received_at, session_id, hook_event_name, payload_json) VALUES (?, ?, ?, ?) RETURNING id, received_at",
  );
  const listAllStmt = db.prepare("SELECT * FROM events ORDER BY id ASC");
  const listBySessionStmt = db.prepare(
    "SELECT * FROM events WHERE session_id = ? ORDER BY id ASC",
  );
  const listSessionsStmt = db.prepare(`
    SELECT
      session_id,
      MIN(received_at) AS first_seen_at,
      MAX(received_at) AS last_seen_at,
      COUNT(*)         AS event_count,
      (
        SELECT hook_event_name
          FROM events e2
         WHERE e2.session_id = events.session_id
         ORDER BY e2.id DESC
         LIMIT 1
      ) AS last_event_name
    FROM events
    GROUP BY session_id
    ORDER BY last_seen_at DESC, MAX(id) DESC
  `);

  function rowToEvent(row: Row): StoredEvent {
    const parsed = HookPayloadSchema.parse(JSON.parse(row.payload_json));
    return { id: row.id, received_at: row.received_at, payload: parsed };
  }

  return {
    append(payload) {
      const now = Date.now();
      const inserted = insertStmt.get(
        now,
        payload.session_id,
        payload.hook_event_name,
        JSON.stringify(payload),
      ) as { id: number; received_at: number };
      return { id: inserted.id, received_at: inserted.received_at, payload };
    },

    list(filter) {
      const rows = filter?.session_id
        ? (listBySessionStmt.all(filter.session_id) as Row[])
        : (listAllStmt.all() as Row[]);
      return rows.map(rowToEvent);
    },

    listSessions() {
      return listSessionsStmt.all() as SessionSummary[];
    },

    close() {
      db.close();
    },
  };
}
