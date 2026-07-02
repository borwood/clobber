import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { SessionReconfigureRequestSchema } from "@clobber/shared";
import type { RuntimeProvider } from "@clobber/runtime";
import type { SessionStore } from "../session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { appendTranscriptNotification } from "../transcript-marker.ts";

interface IdParam {
  id: string;
}

/**
 * `POST /sessions/:id/config` — retune a session's model/effort dials.
 *
 * The dial is always recorded as a session fact (`model_override` /
 * `effort_override`), so it survives resume regardless of runtime. When the
 * session is live on a runtime with the `reconfigure` capability, the change
 * is also pushed over the control channel and applies on the next turn
 * (`applied: "live"`); otherwise it takes effect at the next wake/turn
 * (`applied: "deferred"`).
 */
export function registerSessionReconfigureRoute(
  app: FastifyInstance,
  deps: {
    sessions: SessionStore;
    registry: AgentRegistry;
    runtimeProvider: RuntimeProvider;
  },
): void {
  app.post<{ Params: IdParam }>("/sessions/:id/config", async (request, reply) => {
    const parsed = SessionReconfigureRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid reconfigure", issues: parsed.error.issues };
    }
    const change = parsed.data;
    if (change.model === undefined && change.effort === undefined) {
      reply.code(400);
      return { error: "reconfigure requires model and/or effort" };
    }
    const sessionId = request.params.id;
    const session = deps.sessions.get(sessionId);
    if (session === null) {
      reply.code(404);
      return { error: "session not found" };
    }

    deps.sessions.recordDialOverrides(sessionId, change);

    const live = deps.registry.get(sessionId);
    const appliesLive = live !== null && deps.runtimeProvider.capabilities.reconfigure;
    if (appliesLive) {
      if (change.model !== undefined) {
        live.stdin.write(deps.runtimeProvider.serializeSetModel(randomUUID(), change.model));
      }
      if (change.effort !== undefined) {
        live.stdin.write(deps.runtimeProvider.serializeSetEffort(randomUUID(), change.effort));
      }
      deps.sessions.updateModelEffort(
        sessionId,
        change.model === undefined ? session.model : change.model,
        change.effort === undefined ? session.effort : change.effort,
      );
    }

    if (session.transcript_path !== undefined) {
      const parts = [
        ...(change.model === undefined ? [] : [`model → ${change.model}`]),
        ...(change.effort === undefined ? [] : [`effort → ${change.effort}`]),
      ];
      appendTranscriptNotification(
        session.transcript_path,
        "reconfigured",
        `${parts.join(" · ")}${appliesLive ? "" : " (applies at next wake)"}`,
      );
    }

    return { ok: true, applied: appliesLive ? "live" : "deferred" };
  });
}
