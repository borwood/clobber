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

/**
 * Idempotent end-of-session reaper. Called from both the SessionEnd hook
 * (interactive mode) and from the spawned child's `exit` event (covers
 * `claude -p`, crashes, signals — anywhere SessionEnd never fires).
 * Whichever path runs first wins; the second is a no-op.
 */
export function endSession(sessionId: string, deps: SessionLifecycleDeps): void {
  const session = deps.sessions.get(sessionId);
  if (session === null) return;
  if (session.ended_at !== undefined) return;

  const cancelledIds = deps.agentQuestions.cancelAllForSession(sessionId);
  for (const id of cancelledIds) {
    const row = deps.agentQuestions.get(id);
    if (row !== null) deps.agentQuestionWaiter.notify(row);
  }

  deps.sessions.markEnded(sessionId);
  deps.sessionTokens.revoke(sessionId);
  if (session.agent_id === undefined) return;
  const role = deps.roles.get(session.role_id);
  if (role === null) return;
  if (!role.persistent) deps.agents.delete(session.agent_id);
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
