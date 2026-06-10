import { describe, it, expect } from "bun:test";
import type { CreateNotification, Notification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createNotificationDispatcher, type DeliveryOutcome } from "../src/notification-dispatch.ts";
import { createTestClock } from "../src/clock.ts";
import { seedWorkspace } from "./notification-idempotent-emit.helpers.ts";

// ─── AC4 ─────────────────────────────────────────────────────────────────────
// Fall-back-to-unique: absent source_id → null logical_key → always-distinct.
// Un-keyed emitters must never be over-collapsed.
describe("AC4 — fall-back-to-unique: absent source_id → two rows (no dedup)", () => {
  it("two emits with no source_id always produce two distinct rows", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "wake", tag: { kind: "trigger", attrs: { via: "cron" } } },
      provenance: { source_kind: "trigger" }, // no source_id
    };

    let transportCount = 0;
    const transport = async (_n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      return { action: "queued" };
    };

    const r1 = await dispatcher.emit(req, transport);
    const r2 = await dispatcher.emit(req, transport);

    // Two distinct rows — un-keyed emits are never collapsed
    expect(store.listForAgent(agentId)).toHaveLength(2);
    expect(transportCount).toBe(2);
    expect(r1.notification.id).not.toBe(r2.notification.id);
    expect(r1.outcome.action).not.toBe("skipped-duplicate");
    expect(r2.outcome.action).not.toBe("skipped-duplicate");

    db.close();
  });
});
