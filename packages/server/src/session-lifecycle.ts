import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { SessionTokenStore } from "./session-token-store.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";
import type { AgentRegistry } from "./agent-registry.ts";

export interface SessionLifecycleDeps {
  readonly sessions: SessionStore;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly sessionTokens: SessionTokenStore;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
}

export interface SessionTerminationDeps extends SessionLifecycleDeps {
  readonly registry: AgentRegistry;
}

// Identifies the session this call actually transitioned to ended, so callers
// can fire a one-shot side effect (the `session-ended` wake) exactly once
// regardless of which reaper path won the race.
export interface EndedSessionInfo {
  readonly sessionId: string;
  readonly workspaceId: string;
}

/**
 * Idempotent end-of-session reaper. Called from both the SessionEnd hook
 * (interactive mode) and from the spawned child's `exit` event (covers
 * `claude -p`, crashes, signals — anywhere SessionEnd never fires).
 * Whichever path runs first wins; the second is a no-op. Returns the ended
 * session's identity on the winning call, `null` on a no-op — never throws on
 * a missing/already-ended row, since both reaper paths legitimately race.
 */
export function endSession(
  sessionId: string,
  deps: SessionLifecycleDeps,
): EndedSessionInfo | null {
  const session = deps.sessions.get(sessionId);
  if (session === null) return null;
  if (session.ended_at !== undefined) return null;

  const cancelledIds = deps.agentQuestions.cancelAllForSession(sessionId);
  for (const id of cancelledIds) {
    const row = deps.agentQuestions.get(id);
    if (row !== null) deps.agentQuestionWaiter.notify(row);
  }

  deps.sessions.markEnded(sessionId);
  deps.sessionTokens.revoke(sessionId);
  // The agent row is intentionally preserved on end (including for
  // non-persistent workers): `clobber resume` reattaches to the *same* agent id
  // so its worktree, desk, and identity survive a clean exit or a restart. The
  // whiteboard already gates non-persistent agents on having an active session,
  // so a lingering agent row never shows a phantom desk.
  return { sessionId, workspaceId: session.workspace_id };
}

/**
 * Terminate an active session: SIGTERM the live child if registered, then run
 * `endSession` to mark the row ended and revoke its CLI token. Idempotent —
 * `endSession` is safe to call twice (the spawn-pipeline exit handler will
 * also call it once the child actually dies).
 */
export function terminateSession(
  sessionId: string,
  deps: SessionTerminationDeps,
): void {
  const live = deps.registry.get(sessionId);
  if (live !== null) {
    live.kill("SIGTERM");
    deps.registry.unregister(sessionId);
  }
  endSession(sessionId, deps);
}
