import { describe, it, expect } from "bun:test";
import type { CreateNotification, Notification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createNotificationDispatcher, type DeliveryOutcome } from "../src/notification-dispatch.ts";
import { createTestClock } from "../src/clock.ts";
import { seedWorkspace } from "./trigger-dispatch.helpers.ts";

// ─── AC3 ─────────────────────────────────────────────────────────────────────
// Keep-first: once a notification has advanced to delivered or acked, a
// re-emit of the same logical key must NOT reset its state back to pending.
// Resetting would re-create the storm for the rearmPending path (#574).
describe("AC3 — keep-first: re-emit preserves delivered/acked state, no re-delivery", () => {
  it("emit → deliver → re-emit same key: state stays delivered, transport still called only once", async () => {
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
      provenance: { source_kind: "trigger", source_id: "session-delivered-123" },
    };

    let transportCount = 0;
    const transport = async (n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      // Simulate successful delivery
      store.markDelivered(n.id, clock.now().getTime());
      return { action: "spawned" };
    };

    // First emit — creates row and delivers
    const r1 = await dispatcher.emit(req, transport);
    expect(store.get(r1.notification.id)!.state).toBe("delivered");

    // Re-emit same logical key — must not reset state
    const r2 = await dispatcher.emit(req, transport);

    expect(r2.outcome.action).toBe("skipped-duplicate");
    expect(transportCount).toBe(1);

    // The row must still be delivered, not reset to pending
    const row = store.get(r1.notification.id)!;
    expect(row.state).toBe("delivered");

    db.close();
  });

  it("emit → ack → re-emit same key: state stays acked, no re-delivery", async () => {
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
      provenance: { source_kind: "trigger", source_id: "session-acked-456" },
    };

    let transportCount = 0;
    const transport = async (_n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      return { action: "queued" };
    };

    const r1 = await dispatcher.emit(req, transport);
    store.markAcked(r1.notification.id, clock.now().getTime());
    expect(store.get(r1.notification.id)!.state).toBe("acked");

    const r2 = await dispatcher.emit(req, transport);

    expect(r2.outcome.action).toBe("skipped-duplicate");
    expect(transportCount).toBe(1);
    expect(store.get(r1.notification.id)!.state).toBe("acked");

    db.close();
  });
});
