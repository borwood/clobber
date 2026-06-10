import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  NotificationSchema,
  type CreateNotification,
  type Notification,
  type RecipientRef,
} from "@clobber/shared";

export interface NotificationStore {
  // Persist a notification. When the request carries a source_id, a logical_key
  // is derived; ON CONFLICT the existing row is returned with created=false so
  // the dispatcher can skip transport without re-delivering. Absent source_id →
  // null logical_key → always inserted (today's un-keyed behaviour preserved).
  create(req: CreateNotification, now: number): { notification: Notification; created: boolean };
  get(id: string): Notification | null;
  // Advance pending → delivered and stamp delivered_at. The transport calls this
  // once a notification actually reached its recipient (spawned / injected).
  markDelivered(id: string, now: number): boolean;
  listForAgent(agentId: string): readonly Notification[];
  // Phase-2 inbox extensions:
  // Un-acked user notifications (state ∈ {pending,delivered}), newest first.
  listUnackedForUser(): readonly Notification[];
  // Un-acked agent notifications (state ∈ {pending,delivered}), newest first.
  listUnackedForAgent(agentId: string): readonly Notification[];
  // Advance pending/delivered → acked and stamp acked_at. Idempotent: returns
  // false when state is already acked (or cancelled).
  markAcked(id: string, now: number): boolean;
  // All rows in state='pending'. Used by rearmPending to survive restarts.
  listPending(): readonly Notification[];
  // Drain pending quiet rows for an agent: atomically claims each row (UPDATE
  // WHERE state='pending') and returns only those where changes===1. The SELECT
  // is the sole prepared-statement execution on the zero-pending hot path (AC7).
  drainQuietForAgent(agentId: string, now: number): readonly { id: string; body: string }[];
}

interface Row {
  id: string;
  type: string;
  recipient_kind: string;
  recipient_agent_id: string | null;
  priority: string;
  payload_json: string;
  provenance_json: string;
  metadata_json: string;
  state: string;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
  logical_key: string | null;
  delivery_mode: string | null;
}

function rowToRecipient(row: Row): RecipientRef {
  if (row.recipient_kind === "agent") {
    if (row.recipient_agent_id === null) {
      throw new Error(`notification ${row.id}: agent recipient missing agent_id`);
    }
    return { kind: "agent", agent_id: row.recipient_agent_id };
  }
  return { kind: "user" };
}

function rowToNotification(row: Row): Notification {
  const input: Record<string, unknown> = {
    id: row.id,
    type: row.type,
    recipient: rowToRecipient(row),
    priority: row.priority,
    payload: JSON.parse(row.payload_json),
    provenance: JSON.parse(row.provenance_json),
    metadata: JSON.parse(row.metadata_json),
    state: row.state,
    created_at: row.created_at,
  };
  if (row.delivered_at !== null) input["delivered_at"] = row.delivered_at;
  if (row.acked_at !== null) input["acked_at"] = row.acked_at;
  if (row.delivery_mode !== null) input["delivery_mode"] = row.delivery_mode;
  return NotificationSchema.parse(input);
}

export function createNotificationStore(db: Database): NotificationStore {
  const insertStmt = db.prepare(`
    INSERT INTO notifications
      (id, type, recipient_kind, recipient_agent_id, priority,
       payload_json, provenance_json, metadata_json, state, created_at, delivered_at, acked_at, logical_key,
       delivery_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)
    ON CONFLICT(logical_key) WHERE logical_key IS NOT NULL DO NOTHING
  `);
  const getStmt = db.prepare("SELECT * FROM notifications WHERE id = ?");
  const getByLogicalKeyStmt = db.prepare("SELECT * FROM notifications WHERE logical_key = ?");
  const markDeliveredStmt = db.prepare(`
    UPDATE notifications
       SET state = 'delivered', delivered_at = ?
     WHERE id = ? AND state = 'pending'
  `);
  const listForAgentStmt = db.prepare(
    "SELECT * FROM notifications WHERE recipient_agent_id = ? ORDER BY created_at DESC, id DESC",
  );
  const listUnackedForUserStmt = db.prepare(
    "SELECT * FROM notifications WHERE recipient_kind = 'user' AND state IN ('pending','delivered') ORDER BY created_at DESC, id DESC",
  );
  const listUnackedForAgentStmt = db.prepare(
    "SELECT * FROM notifications WHERE recipient_agent_id = ? AND state IN ('pending','delivered') ORDER BY created_at DESC, id DESC",
  );
  const markAckedStmt = db.prepare(
    "UPDATE notifications SET state = 'acked', acked_at = ? WHERE id = ? AND state IN ('pending','delivered')",
  );
  const listPendingStmt = db.prepare(
    "SELECT * FROM notifications WHERE state = 'pending' ORDER BY created_at ASC, id ASC",
  );
  // AC7 hot path: zero-pending drain = exactly ONE prepared-statement execution,
  // no JSON parse, no other work. Retrieves only the fields needed for rendering.
  const selectQuietPendingStmt = db.prepare(
    "SELECT id, payload_json FROM notifications WHERE recipient_agent_id = ? AND state = 'pending' AND delivery_mode = 'quiet' ORDER BY created_at ASC, id ASC",
  );
  const claimQuietRowStmt = db.prepare(
    "UPDATE notifications SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'pending'",
  );

  return {
    create(req, now) {
      const id = randomUUID();
      const recipientAgentId = req.recipient.kind === "agent" ? req.recipient.agent_id : null;
      const metadata = req.metadata === undefined ? {} : req.metadata;
      const logicalKey =
        req.provenance.source_id !== undefined
          ? `${req.provenance.source_kind}:${req.provenance.source_id}:${recipientAgentId ?? "\0user"}`
          : null;
      const deliveryMode = req.delivery_mode ?? null;
      const result = insertStmt.run(
        id,
        req.type,
        req.recipient.kind,
        recipientAgentId,
        req.priority,
        JSON.stringify(req.payload),
        JSON.stringify(req.provenance),
        JSON.stringify(metadata),
        now,
        logicalKey,
        deliveryMode,
      );
      if (result.changes === 0) {
        // ON CONFLICT: return the existing row that owns the logical_key
        const existing = getByLogicalKeyStmt.get(logicalKey) as Row;
        return { notification: rowToNotification(existing), created: false };
      }
      return { notification: rowToNotification(getStmt.get(id) as Row), created: true };
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToNotification(row);
    },

    markDelivered(id, now) {
      return markDeliveredStmt.run(now, id).changes > 0;
    },

    listForAgent(agentId) {
      const rows = listForAgentStmt.all(agentId) as Row[];
      return rows.map(rowToNotification);
    },

    listUnackedForUser() {
      const rows = listUnackedForUserStmt.all() as Row[];
      return rows.map(rowToNotification);
    },

    listUnackedForAgent(agentId) {
      const rows = listUnackedForAgentStmt.all(agentId) as Row[];
      return rows.map(rowToNotification);
    },

    markAcked(id, now) {
      return markAckedStmt.run(now, id).changes > 0;
    },

    listPending() {
      const rows = listPendingStmt.all() as Row[];
      return rows.map(rowToNotification);
    },

    drainQuietForAgent(agentId, now) {
      const rows = selectQuietPendingStmt.all(agentId) as Array<{
        id: string;
        payload_json: string;
      }>;
      if (rows.length === 0) return [];
      const claimed: { id: string; body: string }[] = [];
      for (const row of rows) {
        const { changes } = claimQuietRowStmt.run(now, row.id);
        if (changes === 1) {
          const payload = JSON.parse(row.payload_json) as { body: string };
          claimed.push({ id: row.id, body: payload.body });
        }
      }
      return claimed;
    },
  };
}
