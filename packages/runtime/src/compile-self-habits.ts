import type { Habit, HookEventName } from "@clobber/shared";
import type { HttpHook, HookHandler } from "./spawn-config.ts";

// #271 habit Phase 1 — the STATIC half of the self.* compile seam. A `self.*`
// habit compiles to a Claude Code hook handler ADDED ON TOP of the always-composed
// instrumentation baseline (base/hooks.json). The compile is purely additive: a
// role with zero self.* habits compiles to nothing, so its hooks.json stays
// byte-identical to the baseline (the continuity guard).
//
// Only the wired self.* paths have a settings.json target. The [S] paths
// (self.session-age / self.session-length — no substrate) and the [V*] additive
// paths (self.desk-change / subagent-stop / tool-failure / … — modeled but not
// wired in v1) compile to nothing. `self.session-message` with role:"assistant"
// (MessageDisplay) and `self.compaction` phase:"post" (PostCompact) are likewise
// not wired yet, so they fall through to null.

// The compile TARGET — the 8 wired Claude events base/hooks.json instruments.
type WiredHookEvent = Extract<
  HookEventName,
  "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "PreCompact"
>;

export interface SelfHabitEvent {
  readonly event: WiredHookEvent;
  // self.tool-use rides the native settings.json `tool_name` matcher; every other
  // self path registers a matcher-less handler.
  readonly nativeMatch: boolean;
}

// The single source of truth for self.path → Claude event. The receiver (server)
// reuses this same forward map to decide which incoming events a habit reacts to,
// so compile and evaluation can never drift.
export function claudeEventForHabit(habit: Habit): SelfHabitEvent | null {
  switch (habit.path) {
    case "self.session-message":
      // role:"user" → UserPromptSubmit (wired); role:"assistant" → MessageDisplay (not wired).
      return habit.role === "user" ? { event: "UserPromptSubmit", nativeMatch: false } : null;
    case "self.tool-use":
      return { event: habit.phase === "post" ? "PostToolUse" : "PreToolUse", nativeMatch: true };
    case "self.session-start":
      return { event: "SessionStart", nativeMatch: false };
    case "self.compaction":
      // pre → PreCompact (wired); post → PostCompact (not wired).
      return habit.phase === "pre" ? { event: "PreCompact", nativeMatch: false } : null;
    case "self.stop":
      return { event: "Stop", nativeMatch: false };
    default:
      return null;
  }
}

// Compile a role's habits into the additive hook handlers their self.* paths
// register. The result is keyed by Claude event; each event's handlers are
// MERGED onto the baseline at materialize. Non-self and disabled habits, and
// paths with no wired target, contribute nothing.
export function compileSelfHabits(
  habits: readonly Habit[],
  hookUrl: string,
): { readonly [E in WiredHookEvent]?: readonly HookHandler[] } {
  const out: { [E in WiredHookEvent]?: HookHandler[] } = {};
  const httpHook: HttpHook = { type: "http", url: hookUrl, async: false };

  for (const habit of habits) {
    if (!habit.enabled) continue;
    const mapped = claudeEventForHabit(habit);
    if (mapped === null) continue;

    const handler = buildHandler(habit, mapped, httpHook);
    const existing = out[mapped.event];
    if (existing === undefined) {
      out[mapped.event] = [handler];
    } else {
      existing.push(handler);
    }
  }

  return out;
}

function buildHandler(habit: Habit, mapped: SelfHabitEvent, hook: HttpHook): HookHandler {
  if (!mapped.nativeMatch) return { hooks: [hook] };
  // self.tool-use: the native matcher carries `match` (tool_name). An absent
  // match means "any tool" — the same ".*" the baseline tool handlers use.
  const match = "match" in habit && habit.match !== undefined ? habit.match : ".*";
  return { matcher: match, hooks: [hook] };
}
