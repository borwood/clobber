import { describe, it, expect } from "bun:test";
import { TRIGGER_PATHS, TriggerPathLiteralSchema } from "@clobber/shared";
import { HABIT_MASTER_TEMPLATE, masterTemplatePaths } from "@clobber/runtime";

// #407 Phase 0 — the master template is the engine-shipped catalog of every
// grantable trigger path, grouped by EVALUATOR (axis A): engine-fired (server
// observes) vs harness-fired (Claude Code hooks → settings.json, the self.*
// category). Grants are presence-based — the template is a path catalog, not a
// permission matrix. It must validate against the shared schema and cover every
// path the schema knows (so wiring a [V*] path later is additive, not a bump).

describe("habit master template", () => {
  it("groups paths by evaluator: self.* harness-fired, system.*/workspace.* engine-fired", () => {
    for (const p of HABIT_MASTER_TEMPLATE.harnessFired) {
      expect(p.startsWith("self."), `${p} should be harness-fired`).toBe(true);
    }
    for (const p of HABIT_MASTER_TEMPLATE.engineFired) {
      expect(p.startsWith("self."), `${p} should NOT be harness-fired`).toBe(false);
    }
  });

  it("every template path validates against the shared path-literal schema", () => {
    for (const p of masterTemplatePaths()) {
      expect(TriggerPathLiteralSchema.safeParse(p).success, `${p} valid`).toBe(true);
    }
  });

  it("covers EXACTLY the schema's TRIGGER_PATHS — no missing, no extra", () => {
    expect([...masterTemplatePaths()].sort()).toEqual([...TRIGGER_PATHS].sort());
  });

  it("enumerates the [V*] additive paths so wiring one later is not a schema bump", () => {
    const all = masterTemplatePaths();
    expect(all).toContain("self.subagent-stop");
    expect(all).toContain("self.cwd-change");
    expect(all).toContain("self.config-change");
  });

  it("re-homes status-change engine-fired and desk-change harness-fired", () => {
    expect(HABIT_MASTER_TEMPLATE.engineFired).toContain("workspace.status-change");
    expect(HABIT_MASTER_TEMPLATE.harnessFired).toContain("self.desk-change");
  });
});
