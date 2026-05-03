import type { FastifyInstance } from "fastify";
import { HookPayloadSchema, type HookPayload } from "@clobber/shared";
import type { EventStore } from "../event-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";

export function registerHookRoutes(
  app: FastifyInstance,
  deps: {
    store: EventStore;
    sessions: SessionStore;
    agents: AgentStore;
    roles: RoleStore;
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
  deps: { sessions: SessionStore; agents: AgentStore; roles: RoleStore },
): void {
  if (payload.hook_event_name === "SessionStart") {
    const session = deps.sessions.get(payload.session_id);
    if (session === null) return;
    deps.sessions.updateTranscriptPath(payload.session_id, payload.transcript_path);
    return;
  }

  if (payload.hook_event_name === "SessionEnd") {
    const session = deps.sessions.get(payload.session_id);
    if (session === null) return;
    deps.sessions.markEnded(payload.session_id);
    if (session.agent_id === undefined) return;
    const role = deps.roles.get(session.role_id);
    if (role === null) return;
    if (!role.persistent) deps.agents.delete(session.agent_id);
  }
}
