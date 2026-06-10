import type { Database } from "bun:sqlite";

// Add the nullable delivery_mode column to the notifications table.
// Additive migration: existing rows get NULL (null = interrupt, today's behaviour).
// The column's index is the existing (recipient_agent_id, state, created_at) index —
// delivery_mode is a WHERE predicate in the drain query but does not need its own
// index because recipient_agent_id narrows the scan to a small per-agent set.
export function migrateNotificationDeliveryMode(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (!cols.includes("delivery_mode")) {
    db.exec("ALTER TABLE notifications ADD COLUMN delivery_mode TEXT");
  }
}
