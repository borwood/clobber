import type { FastifyInstance } from "fastify";
import { HookPayloadSchema, type HookPayload } from "@clobber/shared";
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
import { bridgeAskUserQuestion } from "../ask-user-question-bridge.ts";
import { buildFileSizeReminder } from "../file-size-reminder.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";

const DEFAULT_ASK_BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

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
  askBridgeTimeoutMs?: number;
}

export function registerHookRoutes(
  app: FastifyInstance,
  deps: RegisterHookRoutesDeps,
): void {
  const askBridgeTimeoutMs = deps.askBridgeTimeoutMs ?? DEFAULT_ASK_BRIDGE_TIMEOUT_MS;
  app.post("/hook", async (request, reply) => {
    const parsed = HookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid hook payload", issues: parsed.error.issues };
    }
    const payload = parsed.data;
    deps.store.append(payload);
    await applySessionLifecycle(payload, deps);
    if (payload.hook_event_name === "PreToolUse") {
      const denial = guardOfficeBoundary(payload, deps);
      if (denial !== null) return denial;
      const bridged = await bridgeAskUserQuestion(payload, {
        agentQuestions: deps.agentQuestions,
        agentQuestionWaiter: deps.agentQuestionWaiter,
        askTimeoutMs: askBridgeTimeoutMs,
      });
      if (bridged !== null) return bridged;
    }
    if (payload.hook_event_name === "PostToolUse") {
      applyTaskEvent(payload, deps);
      const reminder = buildFileSizeReminder(payload, deps);
      if (reminder !== null) return reminder;
    }
    return { continue: true };
  });
}

async function applySessionLifecycle(
  payload: HookPayload,
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
