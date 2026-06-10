/**
 * Real upgrade-path test for the notification category migration (#616).
 *
 * Fresh :memory: tests prove nothing about pre-existing databases — this test
 * programmatically builds a pre-#616 notifications table (no `category`
 * column), seeds a trigger row and a message row, then boots through the REAL
 * createDatabase() path and asserts:
 *   (a) createDatabase does not throw on the old-shape DB.
 *   (b) The `category` column is present after boot.
 *   (c) Existing trigger rows are backfilled to category='transient'.
 *   (d) Existing message rows are backfilled to category='durable'.
 *   (e) rowToNotification parses both rows without throwing (NotificationSchema
 *       validates the new field).
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";

// Pre-#616 notifications table: all columns EXCEPT category.
// This is the shape any clobber.db created before this PR has on disk.
const PRE_616_NOTIFICATIONS = `
  CREATE TABLE notifications (
    id                 TEXT    PRIMARY KEY,
    type               TEXT    NOT NULL,
    recipient_kind     TEXT    NOT NULL,
    recipient_agent_id TEXT,
    priority           TEXT    NOT NULL,
    payload_json       TEXT    NOT NULL,
    provenance_json    TEXT    NOT NULL,
    metadata_json      TEXT    NOT NULL,
    state              TEXT    NOT NULL DEFAULT 'pending',
    created_at         INTEGER NOT NULL,
    delivered_at       INTEGER,
    acked_at           INTEGER,
    logical_key        TEXT    UNIQUE,
    delivery_mode      TEXT
  )
`;

function seedNotifications(db: Database, agentId: string): { triggerId: string; messageId: string } {
  const triggerId = "pre-616-trigger-1";
  const messageId = "pre-616-message-1";
  const payload = JSON.stringify({ body: "wake", tag: { kind: "trigger", attrs: { via: "cron" } } });
  const provenance = JSON.stringify({ source_kind: "trigger" });
  const meta = JSON.stringify({});

  db.prepare(
    `INSERT INTO notifications (id, type, recipient_kind, recipient_agent_id, priority, payload_json, provenance_json, metadata_json, created_at)
     VALUES (?, 'trigger', 'agent', ?, 'high', ?, ?, ?, 1000)`,
  ).run(triggerId, agentId, payload, provenance, meta);

  const msgPayload = JSON.stringify({ body: "hello", tag: { kind: "message" } });
  const msgProvenance = JSON.stringify({ source_kind: "message" });
  db.prepare(
    `INSERT INTO notifications (id, type, recipient_kind, recipient_agent_id, priority, payload_json, provenance_json, metadata_json, created_at)
     VALUES (?, 'message', 'agent', ?, 'high', ?, ?, ?, 2000)`,
  ).run(messageId, agentId, msgPayload, msgProvenance, meta);

  return { triggerId, messageId };
}

describe("notification-category upgrade path — real-path regression (#616)", () => {
  it("(a) createDatabase on a pre-#616 DB (no category column) does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-616-upgrade-"));
    const dbPath = join(dir, "clobber.db");

    const seed = new Database(dbPath);
    seed.exec(PRE_616_NOTIFICATIONS);
    seed.exec(
      `INSERT INTO notifications (id, type, recipient_kind, priority, payload_json, provenance_json, metadata_json, created_at)
       VALUES ('x', 'trigger', 'user', 'low', '{}', '{}', '{}', 1)`,
    );
    seed.close();

    expect(() => createDatabase(dbPath)).not.toThrow();

    const db = new Database(dbPath);
    const cols = (
      db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).toContain("category");
    db.close();

    rmSync(dir, { recursive: true });
  });

  it("(b-e) trigger rows backfilled to transient, message rows to durable; both parse via NotificationSchema", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-616-backfill-"));
    const dbPath = join(dir, "clobber.db");
    const agentId = "agent-pre-616";

    // Build old-shape DB with a trigger + message row (no category column).
    const seed = new Database(dbPath);
    seed.exec(PRE_616_NOTIFICATIONS);
    const { triggerId, messageId } = seedNotifications(seed, agentId);
    seed.close();

    // Boot through the real migration path.
    const db = createDatabase(dbPath);

    // (b) column present after boot.
    const cols = (
      db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).toContain("category");

    // (c) trigger row → transient.
    const triggerRow = db
      .prepare("SELECT category FROM notifications WHERE id = ?")
      .get(triggerId) as { category: string };
    expect(triggerRow.category).toBe("transient");

    // (d) message row → durable.
    const messageRow = db
      .prepare("SELECT category FROM notifications WHERE id = ?")
      .get(messageId) as { category: string };
    expect(messageRow.category).toBe("durable");

    // (e) both rows parse cleanly through NotificationSchema (via the store).
    const store = createNotificationStore(db);
    // agent recipient: listForAgent parses via rowToNotification.
    const rows = store.listForAgent(agentId);
    expect(rows).toHaveLength(2);
    expect(rows.find((n) => n.id === triggerId)!.category).toBe("transient");
    expect(rows.find((n) => n.id === messageId)!.category).toBe("durable");

    db.close();
    rmSync(dir, { recursive: true });
  });
});
