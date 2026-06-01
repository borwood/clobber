import { describe, it, expect } from "bun:test";
import {
  HabitSchema,
  HabitActionSchema,
  TriggerPathSchema,
  TRIGGER_PATHS,
  TriggerPathLiteralSchema,
  type Habit,
} from "@clobber/shared";

// #407 Phase 0 — the typed substrate for the habit primitive (#398). A habit is
// `trigger-path ∩ { name, enabled, rand?, scope, action }`. We round-trip one
// habit per trigger-path category × action kind, and pin the three amended
// homings (scope default, status-change engine-fired, desk-change self.*).

function roundTrip(value: unknown): Habit {
  const parsed = HabitSchema.parse(value);
  const reparsed = HabitSchema.parse(JSON.parse(JSON.stringify(parsed)));
  expect(reparsed).toEqual(parsed);
  return parsed;
}

describe("habit action union (inject | cli | wake)", () => {
  it("accepts an inject action with an optional bash enrichment", () => {
    expect(HabitActionSchema.parse({ kind: "inject", hint: "remember the runbook" }).kind).toBe(
      "inject",
    );
    expect(
      HabitActionSchema.parse({ kind: "inject", hint: "h", bash: "git status" }).kind,
    ).toBe("inject");
  });

  it("accepts a cli action (clobber <verb>)", () => {
    const a = HabitActionSchema.parse({ kind: "cli", verb: "status", args: ["working", "x"] });
    expect(a).toEqual({ kind: "cli", verb: "status", args: ["working", "x"] });
  });

  it("accepts a wake action that SELECTS a program (does not contain one)", () => {
    const a = HabitActionSchema.parse({ kind: "wake", wake_program: "idle" });
    expect(a.kind).toBe("wake");
  });

  it("rejects an unknown action kind", () => {
    expect(() => HabitActionSchema.parse({ kind: "broadcast" })).toThrow();
  });
});

describe("habit round-trips per trigger-path category", () => {
  it("inject × self.tool-use (harness-fired)", () => {
    const h = roundTrip({
      path: "self.tool-use",
      phase: "pre",
      match: "Bash",
      name: "warn-on-bash",
      action: { kind: "inject", hint: "double-check the command" },
    });
    expect(h.path).toBe("self.tool-use");
    // scope defaults to self (amendment 2)
    expect(h.scope).toBe("self");
    expect(h.enabled).toBe(true);
  });

  it("cli × system.cron (engine-fired)", () => {
    const h = roundTrip({
      path: "system.cron",
      expr: "*/5 * * * *",
      name: "heartbeat",
      action: { kind: "cli", verb: "status" },
    });
    expect(h.path).toBe("system.cron");
  });

  it("wake × workspace.worker-done (engine-fired)", () => {
    const h = roundTrip({
      path: "workspace.worker-done",
      name: "spawn-next",
      action: { kind: "wake", wake_program: "triage" },
    });
    expect(h.path).toBe("workspace.worker-done");
  });

  it("inject × self.session-message with a receiver-side match", () => {
    const h = roundTrip({
      path: "self.session-message",
      role: "user",
      match: "deploy",
      name: "deploy-guard",
      action: { kind: "inject", hint: "did you mean to deploy?" },
    });
    expect(h.path).toBe("self.session-message");
  });

  it("honours an explicit scope:workspace + a rand sampling rate", () => {
    const h = roundTrip({
      path: "workspace.status-change",
      to: "blocked",
      scope: "workspace",
      rand: 0.25,
      name: "watch-blocked",
      action: { kind: "inject", hint: "a teammate is blocked" },
    });
    expect(h.scope).toBe("workspace");
    expect(h.rand).toBe(0.25);
  });
});

describe("amended homings (re-pin over the draft)", () => {
  it("status-change is engine-fired (workspace.*), NOT self.*", () => {
    expect(TRIGGER_PATHS).toContain("workspace.status-change");
    expect(TRIGGER_PATHS).not.toContain("self.status-change");
    const h = HabitSchema.parse({
      path: "workspace.status-change",
      to: "done",
      name: "on-done",
      action: { kind: "cli", verb: "note" },
    });
    // defaults to self scope: the owning agent's transitions only
    expect(h.scope).toBe("self");
  });

  it("desk-change is harness-fired (self.*), NOT workspace.*", () => {
    expect(TRIGGER_PATHS).toContain("self.desk-change");
    expect(TRIGGER_PATHS).not.toContain("workspace.desk-change");
    const h = HabitSchema.parse({
      path: "self.desk-change",
      glob: "*.md",
      name: "desk-watch",
      action: { kind: "inject", hint: "your desk changed" },
    });
    expect(h.path).toBe("self.desk-change");
  });
});

describe("TriggerPathSchema + literals", () => {
  it("every TRIGGER_PATHS entry is a valid path literal", () => {
    for (const p of TRIGGER_PATHS) {
      expect(TriggerPathLiteralSchema.safeParse(p).success).toBe(true);
    }
  });

  it("TriggerPathSchema discriminates on path (predicate-only, no common fields)", () => {
    const t = TriggerPathSchema.parse({ path: "system.webhook", endpoint: "/incoming/build" });
    expect(t.path).toBe("system.webhook");
  });
});
