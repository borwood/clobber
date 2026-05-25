import type { RuntimeProvider } from "@clobber/runtime";
import { endSession, type SessionLifecycleDeps } from "./session-lifecycle.ts";

/**
 * On startup, session-lifetime rows with `ended_at IS NULL` are orphans: the
 * parent server process that owned the live child has died, so the child is
 * dead too. Turn-lifetime providers can have active rows with no live process;
 * those rows stay resumable through the provider thread id.
 *
 * Either way, an active row at boot was live when clobber last closed, so it is
 * flagged `was_live_at_shutdown` first — the UI surfaces these as resume
 * candidates regardless of whether the row is then reaped (session-lifetime) or
 * left active (turn-lifetime). The flag clears when the session is resumed.
 */
export function reapOrphanedSessions(
  deps: SessionLifecycleDeps & { readonly runtimeProvider?: RuntimeProvider },
): void {
  for (const session of deps.sessions.listActive()) {
    deps.sessions.markWasLiveAtShutdown(session.id);
    if (
      deps.runtimeProvider?.capabilities.processLifetime === "turn" &&
      session.runtime_provider === deps.runtimeProvider.id
    ) {
      continue;
    }
    endSession(session.id, deps);
  }
}
