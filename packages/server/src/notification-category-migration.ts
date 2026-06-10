import type { Database } from "bun:sqlite";

// Add the nullable category column to the notifications table and backfill
// existing rows by type. Additive migration: existing rows get 'transient'
// as the DEFAULT, then message/ask rows are updated to 'durable' so pre-#616
// data is correctly categorised going forward.
export function migrateNotificationCategory(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (!cols.includes("category")) {
    db.exec("ALTER TABLE notifications ADD COLUMN category TEXT NOT NULL DEFAULT 'transient'");
    db.exec("UPDATE notifications SET category = 'durable' WHERE type IN ('message', 'ask')");
  }
}
