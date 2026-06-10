import type { FastifyInstance } from "fastify";
import { InboundHookPayloadSchema, type InboundHookPayload, type TranscriptLine } from "@clobber/shared";
import type { EventStore } from "../event-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { RuntimeProvider } from "@clobber/runtime";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import type { AgentStatusLogStore } from "../agent-status-log-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import { endSession } from "../session-lifecycle.ts";
import { applyTaskEvent } from "../task-event-handler.ts";
import { guardOfficeBoundary } from "../office-boundary-guard.ts";
import { guardHabitEdit } from "../guard-habit-edit.ts";
import { evaluateSelfHabits, type HabitReceiverDeps } from "../habit-receiver.ts";
import { bridgeAskUserQuestion } from "../ask-user-question-bridge.ts";
import { buildFileSizeReminder } from "../file-size-reminder.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";
import type { NotificationStore } from "../notification-store.ts";
import type { Clock } from "../clock.ts";

// The bridge re-arms each window and never expires the ask (#241); this is the
// long-poll heartbeat, not a deadline.
const DEFAULT_ASK_BRIDGE_POLL_WINDOW_MS = 25 * 1000;

export interface RegisterHookRoutesDeps {
  store: EventStore;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  agents: AgentStore;
  roles: RoleStore;
  sessionTokens: SessionTokenStore;
  registry: AgentRegistry;
  runtimeProvider: RuntimeProvider;
  agentQuestions: AgentQuestionStore;
  agentQuestionWaiter: AgentQuestionWaiter;
  agentStatusLog: AgentStatusLogStore;
  scheduler: Pick<TriggerScheduler, "fireSessionEnded" | "flushPendingWakes">;
  askBridgePollWindowMs?: number;
  // #271 — the self.* habit seam: resolve the firing session's habits + the
  // injectable evaluator dependencies (RNG sampling, bash enrichment, tail reader).
  resolveSessionHabits: HabitReceiverDeps["resolveSessionHabits"];
  random: HabitReceiverDeps["random"];
  runBash: HabitReceiverDeps["runBash"];
  readTranscriptTail: (path: string) => Promise<TranscriptLine[]>;
  // Quiet-delivery drain: notifications store + clock for drainQuietForAgent.
  notifications: NotificationStore;
  clock: Clock;
}

export function registerHookRoutes(
  app: FastifyInstance,
  deps: RegisterHookRoutesDeps,
): void {
  const askBridgePollWindowMs = deps.askBridgePollWindowMs ?? DEFAULT_ASK_BRIDGE_POLL_WINDOW_MS;
  // Once-per-(session, habit) in-memory latch for self.session-length. Scoped to
  // this registerHookRoutes call so each server instance (test or production)
  // gets its own latch. Server restart resets it — at most one duplicate reminder
  // per restart; acceptable and documented.
  const sessionLengthFired = new Set<string>();
  const latch: HabitReceiverDeps["latch"] = {
    has: (sessionId, habitName) => sessionLengthFired.has(`${sessionId}:${habitName}`),
    mark: (sessionId, habitName) => sessionLengthFired.add(`${sessionId}:${habitName}`),
  };

  app.post("/hook", async (request, reply) => {
    const parsed = InboundHookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid hook payload", issues: parsed.error.issues };
    }
    const payload = parsed.data;
    deps.store.append(payload);
    await applySessionLifecycle(payload, deps);

    // PreToolUse: decision responses (deny/bridge) always short-circuit. These
    // are not additionalContext producers and must not be composed.
    if (payload.hook_event_name === "PreToolUse") {
      const denial = guardOfficeBoundary(payload, deps);
      if (denial !== null) return denial;
      const habitDenial = guardHabitEdit(payload, deps);
      if (habitDenial !== null) return habitDenial;
      const bridged = await bridgeAskUserQuestion(payload, {
        agentQuestions: deps.agentQuestions,
        agentQuestionWaiter: deps.agentQuestionWaiter,
        askPollWindowMs: askBridgePollWindowMs,
      });
      if (bridged !== null) return bridged;
    }

    if (payload.hook_event_name === "PostToolUse") {
      applyTaskEvent(payload, deps);
    }

    // Composer: collect all additionalContext producers into one hookSpecificOutput
    // wrapper. Fixes the silent drop of co-firing producers (#AC2 — file-size +
    // habit hints were mutually exclusive before this lift). The hookSpecificOutput
    // wrapper echoing the firing event's name is mandatory (bare form silently
    // fails — spike-proven). PreToolUse deny habits still short-circuit above.
    const producers: string[] = [];

    if (payload.hook_event_name === "PostToolUse") {
      const reminder = buildFileSizeReminder(payload, deps);
      if (reminder !== null) producers.push(reminder.hookSpecificOutput.additionalContext);
    }

    // evaluateSelfHabits returns HabitInjection | HabitDenial | null.
    // HabitDenial (PreToolUse only) still short-circuits; inject → collected.
    const habitResult = await evaluateSelfHabits(payload, {
      ...deps,
      readTranscriptTail: deps.readTranscriptTail,
      latch,
    });
    if (habitResult !== null) {
      const out = habitResult.hookSpecificOutput;
      if ("permissionDecision" in out) {
        return habitResult;
      }
      producers.push(out.additionalContext);
    }

    // Quiet-notification drain: surfaces pending quiet rows on UserPromptSubmit
    // and PostToolUse only (the hook-set wired in the spike: #AC1).
    if (
      payload.hook_event_name === "UserPromptSubmit" ||
      payload.hook_event_name === "PostToolUse"
    ) {
      const session = deps.sessions.get(payload.session_id);
      if (session?.agent_id !== undefined) {
        const drained = deps.notifications.drainQuietForAgent(
          session.agent_id,
          deps.clock.now().getTime(),
        );
        for (const item of drained) producers.push(item.body);
      }
    }

    if (producers.length === 0) return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: payload.hook_event_name,
        additionalContext: producers.join("\n\n"),
      },
    };
  });
}

async function applySessionLifecycle(
  payload: InboundHookPayload,
  deps: {
    sessions: SessionStore;
    agents: AgentStore;
    roles: RoleStore;
    sessionTokens: SessionTokenStore;
    registry: AgentRegistry;
    runtimeProvider: RuntimeProvider;
    agentQuestions: AgentQuestionStore;
    agentQuestionWaiter: AgentQuestionWaiter;
    scheduler: Pick<TriggerScheduler, "fireSessionEnded" | "flushPendingWakes">;
  },
): Promise<void> {
  const session = deps.sessions.get(payload.session_id);
  if (session === null) return;

  if (session.transcript_path !== payload.transcript_path) {
    deps.sessions.updateTranscriptPath(payload.session_id, payload.transcript_path);
  }

  if (payload.hook_event_name === "Stop") {
    deps.registry.setBusy(payload.session_id, false);
    // Busy→idle is the safe boundary to release the completion wakes that were
    // queued while the manager was mid-turn (#171).
    if (session.agent_id !== undefined) {
      await deps.scheduler.flushPendingWakes(session.agent_id);
    }
  }

  if (payload.hook_event_name === "SessionEnd") {
    const ended = endSession(payload.session_id, deps);
    if (ended !== null) {
      await deps.scheduler.fireSessionEnded(ended.workspaceId, ended.sessionId);
    }
  }
}
