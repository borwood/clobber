import type { RuntimeProvider } from "@clobber/runtime";
import { endSession, type SessionLifecycleDeps } from "./session-lifecycle.ts";

/**
 * At boot, probe each active session row to determine if it's a genuine orphan.
 *
 * Session-lifetime providers (e.g. claude) spawn a child process whose pid is
 * recorded on the session row. Under `bun --hot` the server restarts but the
 * child may still be running — probing `process.kill(pid, 0)` distinguishes a
 * live child (skip the row) from a genuinely dead one (reap it). Only dead-child
 * rows are flagged `was_live_at_shutdown` and ended; a live child's row is left
 * completely untouched.
 *
 * Turn-lifetime providers (e.g. codex) resume via a provider-managed thread id
 * regardless of server restart, so those rows are always left active and flagged
 * as resume candidates.
 *
 * The `was_live_at_shutdown` flag clears when the session is resumed.
 */
export function reapOrphanedSessions(
  deps: SessionLifecycleDeps & { readonly runtimeProvider?: RuntimeProvider },
): void {
  for (const session of deps.sessions.listActive()) {
    if (
      deps.runtimeProvider?.capabilities.processLifetime === "turn" &&
      session.runtime_provider === deps.runtimeProvider.id
    ) {
      deps.sessions.markWasLiveAtShutdown(session.id);
      continue;
    }
    let alive: boolean;
    try {
      process.kill(session.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) continue;
    deps.sessions.markWasLiveAtShutdown(session.id);
    endSession(session.id, deps);
  }
}
