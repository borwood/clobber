import type { RuntimeProvider } from "@clobber/runtime";
import { endSession, type SessionLifecycleDeps } from "./session-lifecycle.ts";

/**
 * At boot, probe each active session row to determine if it's a genuine orphan.
 *
 * Session-lifetime providers (e.g. claude) spawn a child process whose pid is
 * recorded on the session row. Under `bun --hot` the server restarts but the
 * child may still be running — probing `process.kill(pid, 0)` distinguishes a
 * live pid (skip the row) from a dead one (reap it). Only dead-pid rows are
 * flagged `was_live_at_shutdown` and ended; a live-pid row is left untouched.
 *
 * Caveat: the probe checks pid liveness, not process identity. Across a full
 * reboot or long downtime, pid reuse could recycle a dead child's slot onto an
 * unrelated live process — that row would be wrongly spared. The probability is
 * low under `bun --hot` ms-scale restarts (no OS reboot, pid namespace intact)
 * and this is strictly better than the old reap-everything behavior. Robust
 * identity verification (start-time / cmdline / spawn-epoch comparison) is a
 * tracked follow-up.
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
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        alive = false; // no such process — genuinely dead
      } else if (code === "EPERM") {
        alive = true; // process exists but is unsignalable — treat as live
      } else {
        throw e; // unexpected OS error — surface it, don't silently misclassify
      }
    }
    if (alive) continue;
    deps.sessions.markWasLiveAtShutdown(session.id);
    endSession(session.id, deps);
  }
}
