import { type TriggerPathLiteral } from "@clobber/shared";

// #398 habit primitive (#407 Phase 0) — the engine-shipped MASTER TEMPLATE: the
// canonical catalog of every grantable trigger path, grouped by EVALUATOR (axis
// A of the trigger model). Grants are presence-based (re-pin amendment 1), so
// this is a path catalog, not a permission matrix — a role grants a path by
// having it in its habit tree, not by an entry here.
//
//   engineFired  — the clobber server observes the event (system.*/workspace.*,
//                  including the re-homed workspace.status-change, amendment 4).
//   harnessFired — Claude Code hooks fire in-session and compile to settings.json
//                  (the self.* category, including the re-homed self.desk-change,
//                  amendment 3). Includes the [V*] additive paths so wiring one
//                  later is additive, not a schema bump.
export const HABIT_MASTER_TEMPLATE = {
  engineFired: [
    "system.cron",
    "system.webhook",
    "workspace.open",
    "workspace.worker-done",
    "workspace.session-ended",
    "workspace.status-change",
  ],
  harnessFired: [
    "self.session-message",
    "self.tool-use",
    "self.session-start",
    "self.compaction",
    "self.stop",
    "self.desk-change",
    "self.session-age",
    "self.session-length",
    "self.subagent-stop",
    "self.tool-failure",
    "self.notification",
    "self.permission",
    "self.cwd-change",
    "self.config-change",
  ],
} as const satisfies Record<"engineFired" | "harnessFired", readonly TriggerPathLiteral[]>;

// Every path the template enumerates. The `satisfies` above pins each entry to a
// valid TriggerPathLiteral at compile time; the role-tree round-trip test pins
// EXACT coverage of the schema's TRIGGER_PATHS (no missing, no extra).
export function masterTemplatePaths(): readonly TriggerPathLiteral[] {
  return [...HABIT_MASTER_TEMPLATE.engineFired, ...HABIT_MASTER_TEMPLATE.harnessFired];
}
