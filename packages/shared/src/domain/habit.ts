import { z } from "zod";
import { HabitActionSchema } from "./habit-actions.ts";
import { TriggerPathSchema } from "./habit-trigger-paths.ts";

// #398 habit primitive (#407 Phase 0). A habit is one file in the role git tree:
// a trigger-path ∩ the common config below + the action it fires. The discriminant
// (`path`) and the predicate fields live in habit-trigger-paths.ts; the action
// union in habit-actions.ts. This file composes them and adds the desk artifacts
// (composed view), the runtime capability seam, and the edit-gate denial type.
//
// Re-export the siblings so `@clobber/shared` consumers import the whole
// primitive from one surface.
export * from "./habit-actions.ts";
export * from "./habit-trigger-paths.ts";

const KEBAB = /^[a-z][a-z0-9-]*$/;

// Common config layered onto every trigger-path. `scope` is axis B of the
// trigger model (re-pin amendment 2): self vs cross-agent/workspace, defaulting
// to self. It is a predicate + grant field, not a separate path branch.
const commonHabitFields = {
  name: z.string().regex(KEBAB), // stable id within its path
  enabled: z.boolean().default(true),
  rand: z.number().min(0).max(1).optional(), // receiver-side sampling, anti-nagware
  scope: z.enum(["self", "workspace"]).default("self"),
  action: HabitActionSchema,
};

// The discriminated trigger-path intersected with the common fields. Discrimination
// on `path` survives the intersection, so a parsed Habit narrows by `path`.
export const HabitSchema = z.intersection(TriggerPathSchema, z.object(commonHabitFields));
export type Habit = z.infer<typeof HabitSchema>;

// ── Composed view (the desk artifact, read-mostly) ────────────────────────────
// Re-pin amendment 1: the floor + subtractive master are killed. Grants are
// purely presence-based — a path present in the role's habit tree is granted;
// absent = not granted. A PathGrant is just its habits (possibly empty: granted,
// ready for self-authoring). No `policy` field — re-add `{policy:"deny"}`
// additively only if an untrusted self-authoring agent ever exists (YAGNI).
export const PathGrantSchema = z.object({
  habits: z.array(HabitSchema).default([]),
});
export type PathGrant = z.infer<typeof PathGrantSchema>;

// The composed effective view: engine ∪ workspace ∪ role ∪ self, materialized at
// spawn. Keyed by category → path → grant.
export const ComposedHabitsSchema = z.object({
  system: z.record(z.string(), PathGrantSchema),
  workspace: z.record(z.string(), PathGrantSchema),
  self: z.record(z.string(), PathGrantSchema),
});
export type ComposedHabits = z.infer<typeof ComposedHabitsSchema>;

// ── Runtime capability seam (#337) ────────────────────────────────────────────
// Does a runtime emit in-session reactive hooks that self.* habits compile to?
// claude: true · codex (turn-based, no hooks): false. Phase 0 defines the flag;
// wiring it into RuntimeProviderCapabilities is Phase 1.
export interface InSessionHabitsCapability {
  readonly inSessionHabits: boolean;
}

// ── Edit-gate denial (re-pin amendment 5) ─────────────────────────────────────
// The Phase 1 gate (`guardHabitEdit`) rides the always-on PreToolUse
// instrumentation and denies an edit that violates the role's habit grant. The
// deny shape matches the ask-bridge (ask-user-question-bridge.ts) — the correct
// precedent — NOT the legacy top-level `{decision:"block"}` (PreToolUse is
// excluded from that shape per the Claude Code hooks reference; office-boundary
// guard's divergence is tracked as #406). Phase 0 defines the type; no wiring.
export interface HabitGateDenial {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "deny";
    readonly permissionDecisionReason: string;
  };
}
