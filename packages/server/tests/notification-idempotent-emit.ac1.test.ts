import { describe, it, expect } from "bun:test";
import type { CreateNotification, Notification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createNotificationDispatcher, type DeliveryOutcome } from "../src/notification-dispatch.ts";
import { createTestClock } from "../src/clock.ts";
import { seedWorkspace, NOOP_TRANSPORT } from "./notification-idempotent-emit.helpers.ts";

// ─── AC1 ─────────────────────────────────────────────────────────────────────
// Same logical event emitted twice: the store must produce exactly 1 row AND
// the transport must be invoked exactly once. Counting rows alone is the
// green-but-inert trap (#430/#522) — we count DELIVERY calls here.
describe("AC1 — non-inert dedup: same logical event twice → 1 row, transport once", () => {
  it("emitting the same source_id twice: 1 row, transport called exactly once, 2nd returns skipped-duplicate", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "wake", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
      provenance: { source_kind: "trigger", source_id: "session-abc-123" },
    };

    let transportCount = 0;
    const countingTransport = async (n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      return NOOP_TRANSPORT(n);
    };

    const r1 = await dispatcher.emit(req, countingTransport);
    const r2 = await dispatcher.emit(req, countingTransport);

    // Exactly 1 row — duplicates must not accumulate
    expect(store.listForAgent(agentId)).toHaveLength(1);

    // Transport invoked exactly once — the storm is gated, not just row-deduplicated
    expect(transportCount).toBe(1);

    // 1st emit went through transport normally
    expect(r1.outcome.action).not.toBe("skipped-duplicate");

    // 2nd emit short-circuited at the idempotency gate
    expect(r2.outcome.action).toBe("skipped-duplicate");

    // Both returns carry the same underlying notification row
    expect(r2.notification.id).toBe(r1.notification.id);

    db.close();
  });
});
