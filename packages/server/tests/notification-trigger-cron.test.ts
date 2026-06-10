import { describe, it, expect } from "bun:test";
import type { RoleTrigger } from "@clobber/shared";
import { dispatchTrigger } from "../src/trigger-dispatch.ts";
import { makeDispatchHarness } from "./trigger-dispatch.helpers.ts";

// ─── Cron key honesty (#590) ──────────────────────────────────────────────────
// cron must NOT produce a source_id. Wall-clock firedAt is unique per dispatch
// call — "cron:${expr}:${firedAt}" looks like a dedup key but never actually
// dedups anything. Honest behaviour: return undefined so logical_key is NULL
// and each tick is always-inserted (the same no-dedup semantics cron already had,
// but without the misleading look-armed key).
describe("cron trigger dispatch — honest no-dedup (source_id is undefined)", () => {
  it("cron dispatch produces a notification with no source_id (null logical_key)", async () => {
    const h = makeDispatchHarness();
    const trigger: RoleTrigger = { kind: "cron", expr: "* 9 * * *" };

    await dispatchTrigger(h.deps, h.binding, trigger, undefined);

    const rows = h.notifications.listForAgent(h.binding.agentId);
    expect(rows).toHaveLength(1);
    // source_id must be absent — cron carries no stable occurrence identity
    expect(rows[0]!.provenance.source_id).toBeUndefined();
  });

  it("two cron dispatches produce two independent rows (no dedup, not collapsed)", async () => {
    const h = makeDispatchHarness();
    const trigger: RoleTrigger = { kind: "cron", expr: "* 9 * * *" };

    await dispatchTrigger(h.deps, h.binding, trigger, undefined);
    await dispatchTrigger(h.deps, h.binding, trigger, undefined);

    // Each cron tick is independent — must not be collapsed to 1 row
    expect(h.notifications.listForAgent(h.binding.agentId)).toHaveLength(2);
  });
});
