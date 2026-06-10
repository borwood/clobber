import type { Habit, HookEventName, InboundHookPayload, PathJail, PreToolUsePayload, Session, TranscriptLine } from "@clobber/shared";
import { computeContextLength } from "@clobber/shared";
import { claudeEventForHabit } from "@clobber/runtime";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import { deskDirFor } from "./desk-store.ts";
import { isPathJailed } from "./path-jail.ts";
import { resolveToolPath } from "./tool-write-targets.ts";
import { worktreeRootFor } from "./spawn-worktree.ts";

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
  // Bounded transcript tail-reader for self.session-length evaluation. Injected
  // so tests can count invocations without shelling out to the real filesystem.
  readonly readTranscriptTail: (path: string) => Promise<TranscriptLine[]>;
  // Once-per-(session, habit) in-memory latch for self.session-length. Prevents
  // re-firing on every tool call once the threshold is crossed. Server restart
  // resets the latch → at most one duplicate reminder per restart; acceptable.
  readonly latch: {
    has(sessionId: string, habitName: string): boolean;
    mark(sessionId: string, habitName: string): void;
  };
}

export async function evaluateSelfHabits(
  payload: InboundHookPayload,
  deps: HabitReceiverDeps,
): Promise<HabitInjection | HabitDenial | null> {
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
      if (mapped === null) continue;
      const events = Array.isArray(mapped) ? mapped : [mapped];
      if (!events.some((ev) => ev.event === payload.hook_event_name)) continue;
      if (!matchesHabit(habit, payload, subject)) continue;
      if (habit.rand !== undefined && deps.random() >= habit.rand) continue;
      const predicate = expandSentinels(habit.action.predicate, session, deps);
      if (!isPathJailed(predicate, payload as PreToolUsePayload)) continue;
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
    if (mapped === null) continue;
    const events = Array.isArray(mapped) ? mapped : [mapped];
    if (!events.some((ev) => ev.event === payload.hook_event_name)) continue;
    if (!matchesHabit(habit, payload, subject)) continue;
    if (habit.rand !== undefined && deps.random() >= habit.rand) continue;

    // self.session-length: bounded tail-read + threshold check + one-shot latch.
    if (habit.path === "self.session-length") {
      if (deps.latch.has(payload.session_id, habit.name)) continue;
      const lines = await deps.readTranscriptTail(payload.transcript_path);
      const contextLength = computeContextLength(lines);
      if (contextLength === undefined || contextLength < habit.max_tokens) continue;
      deps.latch.mark(payload.session_id, habit.name);
    }

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
function matchSubject(payload: InboundHookPayload): string | null {
  if (payload.hook_event_name === "UserPromptSubmit") return payload.prompt;
  if (payload.hook_event_name === "PreToolUse" || payload.hook_event_name === "PostToolUse") {
    return payload.tool_name;
  }
  return null;
}

function matchesHabit(habit: Habit, payload: InboundHookPayload, subject: string | null): boolean {
  if (habit.path === "self.session-start") {
    if (habit.source === undefined) return true;
    return payload.hook_event_name === "SessionStart" && payload.source === habit.source;
  }
  // Mirrors Claude matcher semantics: exact | '|'-list | regex all fall out of a
  // single regex test (`Bash`, `Edit|Write`, `.*` are all valid patterns).
  const match = "match" in habit ? habit.match : undefined;
  if (match !== undefined) {
    if (subject === null) return false;
    if (!new RegExp(match).test(subject)) return false;
  }
  if (habit.path === "self.tool-use") {
    // payload is Pre/PostToolUse when self.tool-use fires (guaranteed by claudeEventForHabit gate).
    const tp = payload as { tool_name: string; tool_input: Record<string, unknown>; cwd: string };
    if (habit.match_path !== undefined) {
      // Real branch keyed on tool_name — mirrors writeTargets()'s empty-return contract.
      if (tp.tool_name === "Write" || tp.tool_name === "Edit" || tp.tool_name === "MultiEdit") {
        const fp = tp.tool_input["file_path"];
        if (typeof fp !== "string" || fp.length === 0) return false;
        if (!new RegExp(habit.match_path).test(resolveToolPath(fp, tp.cwd))) return false;
      } else {
        return false;
      }
    }
    if (habit.match_command !== undefined) {
      // Real branch keyed on tool_name — mirrors writeTargets()'s empty-return contract.
      if (tp.tool_name === "Bash") {
        const cmd = tp.tool_input["command"];
        if (typeof cmd !== "string" || cmd.length === 0) return false;
        if (!new RegExp(habit.match_command).test(cmd)) return false;
      } else {
        return false;
      }
    }
  }
  return true;
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

// Expand sentinel placeholders stored in the role git tree with real paths
// derived from the session's workspace at evaluation time. This keeps the
// habit JSON generic (no hardcoded absolute paths), while letting the
// predicate refer to per-workspace locations.
//
//   __REPO_PATH__    → workspace.repo_path
//   __WORKTREE_ROOT__ → derived from repo_path + session.label + spawn_worktree
//   __DESK_DIR__     → .clobber/agents/<agent_id>/desk/ under repo_path
//
// A sentinel that cannot be resolved (no workspace, no agent_id) stays as-is —
// it never matches a real absolute path so the habit is a no-op.
function expandSentinels(
  predicate: PathJail,
  session: Session,
  deps: HabitReceiverDeps,
): PathJail {
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) return predicate;

  const repoPath = workspace.repo_path;
  const worktreeRoot = worktreeRootFor(repoPath, session.label, workspace.spawn_worktree);
  const deskDir =
    session.agent_id !== undefined ? deskDirFor(repoPath, session.agent_id) : undefined;

  function expand(s: string): string {
    let result = s;
    result = result.replace(/__REPO_PATH__/g, repoPath);
    result = result.replace(/__WORKTREE_ROOT__/g, worktreeRoot);
    if (deskDir !== undefined) result = result.replace(/__DESK_DIR__/g, deskDir);
    return result;
  }

  return {
    outside: expand(predicate.outside),
    under: predicate.under !== undefined ? expand(predicate.under) : undefined,
    except: predicate.except !== undefined ? expand(predicate.except) : undefined,
  };
}
