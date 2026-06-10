import { describe, it, expect } from "bun:test";
import type { RoleTrigger } from "@clobber/shared";
import { dispatchTrigger } from "../src/trigger-dispatch.ts";
import type { CompletionWakePayload } from "../src/completion-wake.ts";
import { makeDispatchHarness } from "./notification-idempotent-emit.helpers.ts";

// ─── AC2 ─────────────────────────────────────────────────────────────────────
// Two completion triggers for different sessions must NOT be collapsed.
// This guards the source_id re-grain in trigger-dispatch: if source_id stays
// "trigger.kind" (= "worker-done" for both) they share the same logical key
// and the 2nd event is swallowed.
describe("AC2 — distinct-don't-collapse: two sessions → two notification rows", () => {
  it("worker-done for session-A then session-B produces 2 distinct notification rows", async () => {
    const h = makeDispatchHarness();
    const TRIGGER: RoleTrigger = { kind: "worker-done" };

    const payloadA: CompletionWakePayload = {
      ended: [{ sessionId: "worker-session-a", label: "worker-a", summary: "done" }],
    };
    const payloadB: CompletionWakePayload = {
      ended: [{ sessionId: "worker-session-b", label: "worker-b", summary: "done" }],
    };

    await dispatchTrigger(h.deps, h.binding, TRIGGER, payloadA);
    await dispatchTrigger(h.deps, h.binding, TRIGGER, payloadB);

    // Two distinct completion events → two distinct notification rows.
    // Fails if source_id is "worker-done" for both (same logical_key → dedup → 1 row).
    expect(h.notifications.listForAgent(h.binding.agentId)).toHaveLength(2);

    // The two rows carry different provenance (different source_ids after re-grain)
    const rows = h.notifications.listForAgent(h.binding.agentId);
    expect(rows[0]!.provenance.source_id).not.toBe(rows[1]!.provenance.source_id);
  });
});
