import { endSession, type SessionLifecycleDeps } from "./session-lifecycle.ts";

/**
 * On startup, every session row with `ended_at IS NULL` is an orphan: the
 * parent server process that owned the live `claude` child has died, so the
 * child is dead too (children of an exited parent are reaped by the OS).
 * Reap them here so the next boot starts with a coherent view of which
 * sessions / agents are alive.
 */
export function reapOrphanedSessions(deps: SessionLifecycleDeps): void {
  for (const session of deps.sessions.listActive()) {
    endSession(session.id, deps);
  }
}
