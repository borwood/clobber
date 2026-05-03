import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { RoleStore } from "./role-store.ts";

export interface SessionLifecycleDeps {
  readonly sessions: SessionStore;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
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

  deps.sessions.markEnded(sessionId);
  if (session.agent_id === undefined) return;
  const role = deps.roles.get(session.role_id);
  if (role === null) return;
  if (!role.persistent) deps.agents.delete(session.agent_id);
}
