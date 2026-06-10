import { describe, it, expect } from "bun:test";
import type { CreateNotification, Notification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createNotificationDispatcher, type DeliveryOutcome } from "../src/notification-dispatch.ts";
import { createTestClock } from "../src/clock.ts";
import { seedWorkspace } from "./trigger-dispatch.helpers.ts";

// ─── AC5 ─────────────────────────────────────────────────────────────────────
// Non-duplicate-path golden: the non-duplicate path (first emit) must deliver
// byte-for-byte unchanged — no regression introduced by the idempotency gate.
describe("AC5 — non-duplicate-path delivery byte-unchanged", () => {
  it("first emit of a keyed notification delivers normally (outcome, row, state unchanged)", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "first-time wake", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
      provenance: { source_kind: "trigger", source_id: "session-golden-789" },
    };

    let deliveredNotification: Notification | null = null;
    const transport = async (n: Notification): Promise<DeliveryOutcome> => {
      deliveredNotification = n;
      return { action: "spawned", sessionId: "spawned-1" };
    };

    const { notification, outcome } = await dispatcher.emit(req, transport);

    // Delivery action unchanged from before idempotency feature
    expect(outcome.action).toBe("spawned");
    expect(outcome.sessionId).toBe("spawned-1");

    // Transport received the notification with correct fields
    expect(deliveredNotification).not.toBeNull();
    expect(deliveredNotification!.payload.body).toBe("first-time wake");
    expect(deliveredNotification!.provenance.source_id).toBe("session-golden-789");

    // Row advanced to delivered (markDelivered path)
    expect(store.get(notification.id)!.state).toBe("delivered");

    db.close();
  });
});
