import { describe, it, expect } from "bun:test";
import { createDatabase } from "../src/db.ts";

// ─── AC6 ─────────────────────────────────────────────────────────────────────
// DB-enforced uniqueness: the partial unique index must enforce the constraint
// at the database level, not app-level check-then-write (no TOCTOU). Verified
// by inserting directly into the DB and confirming the constraint fires.
describe("AC6 — DB-enforced uniqueness via partial unique index", () => {
  it("direct SQL insert of duplicate logical_key is rejected by the DB (ON CONFLICT DO NOTHING)", () => {
    const db = createDatabase(":memory:");

    // The idx_notifications_logical_key index must exist on the notifications table
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications' AND name='idx_notifications_logical_key'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);

    // Direct raw insert confirms DB-level enforcement (not app-level guard)
    db.exec(`
      INSERT INTO notifications
        (id, type, recipient_kind, recipient_agent_id, priority,
         payload_json, provenance_json, metadata_json, state, created_at,
         delivered_at, acked_at, logical_key)
      VALUES
        ('id-1','trigger','agent',NULL,'low','{}','{}','{}','pending',1,NULL,NULL,'test-key'),
        ('id-2','trigger','agent',NULL,'low','{}','{}','{}','pending',2,NULL,NULL,NULL)
    `);

    // Second insert with same logical_key — DO NOTHING, row count stays at 1 for that key
    const r = db
      .prepare(
        `INSERT INTO notifications
           (id, type, recipient_kind, recipient_agent_id, priority,
            payload_json, provenance_json, metadata_json, state, created_at,
            delivered_at, acked_at, logical_key)
         VALUES ('id-3','trigger','agent',NULL,'low','{}','{}','{}','pending',3,NULL,NULL,'test-key')
         ON CONFLICT(logical_key) WHERE logical_key IS NOT NULL DO NOTHING`,
      )
      .run();
    expect(r.changes).toBe(0);

    // NULL logical_key rows are not deduplicated (partial index excludes NULLs)
    const r2 = db
      .prepare(
        `INSERT INTO notifications
           (id, type, recipient_kind, recipient_agent_id, priority,
            payload_json, provenance_json, metadata_json, state, created_at,
            delivered_at, acked_at, logical_key)
         VALUES ('id-4','trigger','agent',NULL,'low','{}','{}','{}','pending',4,NULL,NULL,NULL)
         ON CONFLICT(logical_key) WHERE logical_key IS NOT NULL DO NOTHING`,
      )
      .run();
    expect(r2.changes).toBe(1); // NULL-key insert always succeeds

    db.close();
  });
});
