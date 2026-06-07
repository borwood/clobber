import type { Habit, HookEventName, HookPayload, PreToolUsePayload, Session } from "@clobber/shared";
import { claudeEventForHabit } from "@clobber/runtime";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import { isPathJailed } from "./path-jail.ts";

// #271 habit Phase 1 — the DYNAMIC half of the self.* seam. The compile side
// (runtime) registers the Claude hook so the harness POSTs the event; this side
// evaluates the firing agent's matching `self.*` habits and returns their hint as
// `hookSpecificOutput.additionalContext` — the same return shape the file-size
// reminder and the ask-bridge already use. The receiver is the matcher for the
// non-native predicates (`match` regex on prompt/tool_name, `rand` sampling) and
// the `bash` enrichment, none of which the static settings.json can express.
export interface HabitInjection {
  readonly hookSpecificOutput: {
    readonly hookEventName: HookEventName;
    readonly additionalContext: string;
  };
}

// #398-D1 — the deny shape, matching HabitGateDenial (ask-bridge precedent).
export interface HabitDenial {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "deny";
    readonly permissionDecisionReason: string;
  };
}

export interface HabitReceiverDeps {
  readonly sessions: SessionStore;
  readonly workspaces: WorkspaceStore;
  // The firing session's habits — embodied from its role (commit-pinned roles
  // carry habits; row-backed roles carry none). Injected so the heavy embodiment
  // wiring stays in server.ts and the evaluator is directly testable.
  readonly resolveSessionHabits: (session: Session) => readonly Habit[];
  // [0,1) sample for `rand` gating; injected so probabilistic habits are testable.
  readonly random: () => number;
  // Runs an `inject` habit's optional `bash`, returning stdout. Injected for the
  // same reason — the evaluator never shells out directly.
  readonly runBash: (command: string, cwd: string) => string;
}

export function evaluateSelfHabits(
  payload: HookPayload,
  deps: HabitReceiverDeps,
): HabitInjection | HabitDenial | null {
  const session = deps.sessions.get(payload.session_id);
  if (session === null) return null;

  const subject = matchSubject(payload);
  const hints: string[] = [];
  for (const habit of deps.resolveSessionHabits(session)) {
    if (!habit.enabled) continue;

    // #398-D1 — refuse branch: evaluated before inject so a matching refuse
    // short-circuits immediately (no point collecting hints if the action is blocked).
    if (habit.action.kind === "refuse") {
      if (payload.hook_event_name !== "PreToolUse") continue;
      const mapped = claudeEventForHabit(habit);
      if (mapped === null || mapped.event !== payload.hook_event_name) continue;
      if (!matchesHabit(habit, payload, subject)) continue;
      if (habit.rand !== undefined && deps.random() >= habit.rand) continue;
      if (!isPathJailed(habit.action.predicate, payload as PreToolUsePayload)) continue;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: habit.action.reason ?? "action refused by habit",
        },
      };
    }

    // cli and wake actions are the scheduler/CLI's concern (Phase 2+).
    if (habit.action.kind !== "inject") continue;
    const mapped = claudeEventForHabit(habit);
    if (mapped === null || mapped.event !== payload.hook_event_name) continue;
    if (!matchesHabit(habit, payload, subject)) continue;
    if (habit.rand !== undefined && deps.random() >= habit.rand) continue;

    hints.push(renderHint(habit.action.hint, habit.action.bash, payload.cwd, deps));
  }

  if (hints.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name,
      additionalContext: hints.join("\n\n"),
    },
  };
}

// The string a `match` regex tests, per event. Events with no match subject
// (Stop, PreCompact, SessionStart) return null — a habit on those fires unless it
// carries a predicate that needs a subject.
function matchSubject(payload: HookPayload): string | null {
  if (payload.hook_event_name === "UserPromptSubmit") return payload.prompt;
  if (payload.hook_event_name === "PreToolUse" || payload.hook_event_name === "PostToolUse") {
    return payload.tool_name;
  }
  return null;
}

function matchesHabit(habit: Habit, payload: HookPayload, subject: string | null): boolean {
  if (habit.path === "self.session-start") {
    if (habit.source === undefined) return true;
    return payload.hook_event_name === "SessionStart" && payload.source === habit.source;
  }
  const match = "match" in habit ? habit.match : undefined;
  if (match === undefined) return true;
  if (subject === null) return false;
  // Mirrors Claude matcher semantics: exact | '|'-list | regex all fall out of a
  // single regex test (`Bash`, `Edit|Write`, `.*` are all valid patterns).
  return new RegExp(match).test(subject);
}

function renderHint(
  hint: string,
  bash: string | undefined,
  cwd: string,
  deps: HabitReceiverDeps,
): string {
  if (bash === undefined) return hint;
  const out = deps.runBash(bash, cwd).trim();
  return out.length === 0 ? hint : `${hint}\n${out}`;
}
