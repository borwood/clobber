import type { Database } from "bun:sqlite";

// Add the nullable logical_key column + partial unique index to the
// notifications table. Additive, no backfill: existing rows get NULL →
// never deduplicated (today's behaviour preserved). Only fresh rows with a
// non-null key participate in the ON CONFLICT dedup path.
export function migrateNotificationLogicalKey(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (!cols.includes("logical_key")) {
    db.exec("ALTER TABLE notifications ADD COLUMN logical_key TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_logical_key ON notifications(logical_key) WHERE logical_key IS NOT NULL",
  );
}
