import type { RuntimeProvider } from "@clobber/runtime";
import type { ClobberPromptTag } from "@clobber/shared";
import type { SessionStore } from "./session-store.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { endSession, type SessionLifecycleDeps } from "./session-lifecycle.ts";
import type { ResumeTurnSuccess, ResumeTurnError } from "./resume-pipeline.ts";

export interface InjectPromptDeps extends SessionLifecycleDeps {
  readonly sessions: SessionStore;
  readonly registry: AgentRegistry;
  readonly runtimeProvider: RuntimeProvider;
  resumeTurn: (input: {
    readonly sessionId: string;
    readonly prompt: string;
  }) => Promise<ResumeTurnSuccess | ResumeTurnError>;
}

export type InjectPromptResult =
  | { readonly ok: true; readonly pid?: number }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly detail?: string;
    };

/**
 * Deliver a user prompt into a session, the #113/#252 path: write to the live
 * child's stdin (an injection-capable runtime natively queues it mid-turn, so
 * it lands in the same conversation whether the agent is idle or busy), or
 * resume a turn-lifetime child whose process has gone. Shared by the
 * `/sessions/:id/prompt` route and the late-ask-answer return path (#183), so
 * a timed-out ask answer rides the exact same delivery as a typed prompt.
 */
export async function injectPrompt(
  sessionId: string,
  prompt: string,
  deps: InjectPromptDeps,
  tag?: ClobberPromptTag,
): Promise<InjectPromptResult> {
  const session = deps.sessions.get(sessionId);
  if (session === null) return { ok: false, status: 404, error: "session not found" };
  if (session.ended_at !== undefined) {
    return { ok: false, status: 410, error: "session ended" };
  }
  const live = deps.registry.get(sessionId);
  // Registry empty for an un-ended row means the child died but the exit
  // handler hasn't reaped yet (or this is a reboot orphan the boot reaper
  // missed). Either way, treat the session as gone — reap now so the sidebar
  // settles on the next poll.
  if (live === null) {
    if (deps.runtimeProvider.capabilities.processLifetime === "turn") {
      const resumed = await deps.resumeTurn({ sessionId, prompt });
      if (!resumed.ok) {
        return resumed.detail === undefined
          ? { ok: false, status: resumed.status, error: resumed.error }
          : { ok: false, status: resumed.status, error: resumed.error, detail: resumed.detail };
      }
      return { ok: true, pid: resumed.pid };
    }
    endSession(sessionId, deps);
    return { ok: false, status: 410, error: "session ended" };
  }
  if (deps.runtimeProvider.capabilities.processLifetime === "turn") {
    return { ok: false, status: 409, error: "agent busy" };
  }
  if (!deps.runtimeProvider.capabilities.livePromptInjection) {
    return { ok: false, status: 409, error: "runtime does not support live prompt injection" };
  }
  // Write straight to stdin even mid-turn: claude's native stdin queue defers a
  // mid-thinking write to a safe tool-result boundary on its own (#367 spike —
  // 14/14, never poisons), so the clobber-side inject queue is redundant. The
  // inject-independent interleaved-thinking poison (#372) is handled by the #360
  // repair half on resume. setBusy marks the turn now in flight.
  live.stdin.write(deps.runtimeProvider.serializeUserPrompt(prompt, tag));
  deps.registry.setBusy(sessionId, true);
  return { ok: true };
}
