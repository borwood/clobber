import { describe, it, expect } from "bun:test";
import {
  PathGrantSchema,
  ComposedHabitsSchema,
  type HabitGateDenial,
  type InSessionHabitsCapability,
} from "@clobber/shared";

// #407 — the seam types. These are defined in Phase 0 but NOT wired (the gate is
// Phase 1, the capability flag is Phase 1). tsc enforces their shape; the runtime
// assertions below pin the amended deny-shape (amendment 5) and the presence-based
// grant (amendment 1 — no `policy` field anywhere).

describe("gate-denial type (amendment 5 — matches the ask-bridge)", () => {
  it("uses hookSpecificOutput.permissionDecision:'deny', NOT the legacy {decision:'block'}", () => {
    const denial: HabitGateDenial = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "edit violates the role's habit grant",
      },
    };
    expect(denial.hookSpecificOutput.permissionDecision).toBe("deny");
    // @ts-expect-error — the legacy top-level block shape is rejected by the type
    const legacy: HabitGateDenial = { decision: "block", reason: "x" };
    expect(legacy).toBeDefined();
  });
});

describe("in-session-habits capability flag (Phase 0 type only)", () => {
  it("is a boolean capability seam (claude:true · codex:false)", () => {
    const claude: InSessionHabitsCapability = { inSessionHabits: true };
    const codex: InSessionHabitsCapability = { inSessionHabits: false };
    expect(claude.inSessionHabits).toBe(true);
    expect(codex.inSessionHabits).toBe(false);
  });
});

describe("composed view is presence-based (amendment 1 — floor killed)", () => {
  it("a PathGrant is just { habits }, no policy field", () => {
    const grant = PathGrantSchema.parse({ habits: [] });
    expect(grant).toEqual({ habits: [] });
    expect("policy" in grant).toBe(false);
  });

  it("ComposedHabits keys system/workspace/self → path → grant", () => {
    const composed = ComposedHabitsSchema.parse({
      system: { "system.cron": { habits: [] } },
      workspace: {},
      self: {},
    });
    expect(composed.system["system.cron"]).toEqual({ habits: [] });
  });
});
