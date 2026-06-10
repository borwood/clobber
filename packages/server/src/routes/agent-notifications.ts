import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NotificationStore } from "../notification-store.ts";
import type { Clock } from "../clock.ts";
import { withAgentAuth, type WithAgentAuthDeps } from "./_with-agent-auth.ts";

export interface NotificationsRouteDeps {
  readonly notifications: NotificationStore;
  readonly clock: Clock;
}

export type AgentNotificationsRouteDeps = NotificationsRouteDeps & WithAgentAuthDeps;

// GET  /notifications?recipient=user  — un-acked user notifications, newest first.
// POST /notifications/:id/ack         — advance to acked, stamp acked_at. Idempotent.
export function registerNotificationsRoutes(
  app: FastifyInstance,
  deps: NotificationsRouteDeps,
): void {
  const QuerySchema = z.object({ recipient: z.literal("user") });

  app.get("/notifications", async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid query", issues: parsed.error.issues };
    }
    const rows = deps.notifications.listUnackedForUser();
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        priority: n.priority,
        state: n.state,
        payload: n.payload,
        provenance: n.provenance,
        created_at: n.created_at,
        delivered_at: n.delivered_at,
      })),
    };
  });

  app.post("/notifications/:id/ack", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const changed = deps.notifications.markAcked(id, deps.clock.now().getTime());
    if (!changed) {
      const n = deps.notifications.get(id);
      if (n === null) {
        reply.code(404);
        return { error: "notification not found" };
      }
      // Already acked — idempotent success
    }
    return { ok: true };
  });
}

// GET  /agent/notifications         — calling agent's un-acked rows; recipient from token.
// POST /agent/notifications/:id/ack — ack own row; 403 on foreign row.
export function registerAgentNotificationsRoutes(
  app: FastifyInstance,
  deps: AgentNotificationsRouteDeps,
): void {
  app.get(
    "/agent/notifications",
    withAgentAuth("notify.list", deps, async (_request, _reply, { session }) => {
      const agentId = session.agent_id!;
      const rows = deps.notifications.listUnackedForAgent(agentId).filter((n) => n.delivery_mode !== "quiet");
      return {
        notifications: rows.map((n) => ({
          id: n.id,
          type: n.type,
          priority: n.priority,
          state: n.state,
          payload: n.payload,
          provenance: n.provenance,
          created_at: n.created_at,
          delivered_at: n.delivered_at,
        })),
      };
    }),
  );

  app.post(
    "/agent/notifications/:id/ack",
    withAgentAuth<{ Params: { id: string } }>("notify.ack", deps, async (request, reply, { session }) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const agentId = session.agent_id!;
      const n = deps.notifications.get(id);
      if (n === null) {
        reply.code(404);
        return { error: "notification not found" };
      }
      if (n.recipient.kind !== "agent" || n.recipient.agent_id !== agentId) {
        reply.code(403);
        return { error: "notification belongs to a different agent" };
      }
      deps.notifications.markAcked(id, deps.clock.now().getTime());
      return { ok: true };
    }),
  );
}
