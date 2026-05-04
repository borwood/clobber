import type { FastifyInstance } from "fastify";
import { HookPayloadSchema, type HookPayload } from "@clobber/shared";
import type { EventStore } from "../event-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import { endSession } from "../session-lifecycle.ts";

export function registerHookRoutes(
  app: FastifyInstance,
  deps: {
    store: EventStore;
    sessions: SessionStore;
    agents: AgentStore;
    roles: RoleStore;
    sessionTokens: SessionTokenStore;
    registry: AgentRegistry;
    agentQuestions: AgentQuestionStore;
    agentQuestionWaiter: AgentQuestionWaiter;
  },
): void {
  app.post("/hook", async (request, reply) => {
    const parsed = HookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid hook payload", issues: parsed.error.issues };
    }
    const payload = parsed.data;
    deps.store.append(payload);
    applySessionLifecycle(payload, deps);
    return { continue: true };
  });
}

function applySessionLifecycle(
  payload: HookPayload,
  deps: {
    sessions: SessionStore;
    agents: AgentStore;
    roles: RoleStore;
    sessionTokens: SessionTokenStore;
    registry: AgentRegistry;
    agentQuestions: AgentQuestionStore;
    agentQuestionWaiter: AgentQuestionWaiter;
  },
): void {
  const session = deps.sessions.get(payload.session_id);
  if (session === null) return;

  if (session.transcript_path !== payload.transcript_path) {
    deps.sessions.updateTranscriptPath(payload.session_id, payload.transcript_path);
  }

  if (payload.hook_event_name === "Stop") {
    deps.registry.setBusy(payload.session_id, false);
  }

  if (payload.hook_event_name === "SessionEnd") {
    endSession(payload.session_id, deps);
  }
}
