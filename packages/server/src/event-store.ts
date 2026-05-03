import type { Database } from "bun:sqlite";
import { HookPayloadSchema, type HookPayload } from "@clobber/shared";

export interface StoredEvent {
  readonly id: number;
  readonly received_at: number;
  readonly payload: HookPayload;
}

export interface ListFilter {
  readonly session_id?: string;
}

export interface EventStore {
  append(payload: HookPayload): StoredEvent;
  list(filter?: ListFilter): StoredEvent[];
}

interface Row {
  id: number;
  received_at: number;
  session_id: string;
  hook_event_name: string;
  payload_json: string;
}

export function createEventStore(db: Database): EventStore {
  const insertStmt = db.prepare(
    "INSERT INTO events (received_at, session_id, hook_event_name, payload_json) VALUES (?, ?, ?, ?) RETURNING id, received_at",
  );
  const listAllStmt = db.prepare("SELECT * FROM events ORDER BY id ASC");
  const listBySessionStmt = db.prepare(
    "SELECT * FROM events WHERE session_id = ? ORDER BY id ASC",
  );

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
  };
}
