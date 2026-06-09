import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db.ts";

// Pre-#589 notifications table: all columns EXCEPT logical_key.
// This is the shape any clobber.db created before the idempotent-emit PR has on disk.
const PRE_589_NOTIFICATIONS = `
  CREATE TABLE notifications (
    id                 TEXT    PRIMARY KEY,
    type               TEXT    NOT NULL,
    recipient_kind     TEXT    NOT NULL,
    recipient_agent_id TEXT,
    priority           TEXT    NOT NULL,
    payload_json       TEXT    NOT NULL,
    provenance_json    TEXT    NOT NULL,
    metadata_json      TEXT    NOT NULL,
    state              TEXT    NOT NULL,
    created_at         INTEGER NOT NULL,
    delivered_at       INTEGER,
    acked_at           INTEGER
  )
`;

// Regression: boot against a pre-#589 DB must succeed and leave the schema in
// the correct post-migration shape (column present, partial unique index present).
// Before the fix, createDatabase throws "no such column: logical_key" because
// SCHEMA's CREATE UNIQUE INDEX runs before the migration that adds the column.
describe("notification-logical-key upgrade path — real-path regression (#591)", () => {
  it("createDatabase on a pre-#589 DB (no logical_key column) does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-591-upgrade-"));
    const dbPath = join(dir, "clobber.db");

    // Build the old-shape DB: notifications table without logical_key
    const seed = new Database(dbPath);
    seed.exec(PRE_589_NOTIFICATIONS);
    seed.close();

    // Before fix: throws "SQLiteError: no such column: logical_key"
    // After fix: must boot cleanly
    expect(() => createDatabase(dbPath)).not.toThrow();

    // Post-boot: column must exist
    const db = new Database(dbPath);
    const cols = (
      db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).toContain("logical_key");

    // Post-boot: partial unique index must exist
    const idx = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications' AND name='idx_notifications_logical_key'",
        )
        .all() as Array<{ name: string }>
    );
    expect(idx).toHaveLength(1);

    db.close();
    rmSync(dir, { recursive: true });
  });
});
