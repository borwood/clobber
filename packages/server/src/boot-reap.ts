import type { RuntimeProvider } from "@clobber/runtime";
import { endSession, type SessionLifecycleDeps } from "./session-lifecycle.ts";

/**
 * On startup, session-lifetime rows with `ended_at IS NULL` are orphans: the
 * parent server process that owned the live child has died, so the child is
 * dead too. Turn-lifetime providers can have active rows with no live process;
 * those rows stay resumable through the provider thread id.
 */
export function reapOrphanedSessions(
  deps: SessionLifecycleDeps & { readonly runtimeProvider?: RuntimeProvider },
): void {
  for (const session of deps.sessions.listActive()) {
    if (
      deps.runtimeProvider?.capabilities.processLifetime === "turn" &&
      session.runtime_provider === deps.runtimeProvider.id
    ) {
      continue;
    }
    endSession(session.id, deps);
  }
}
