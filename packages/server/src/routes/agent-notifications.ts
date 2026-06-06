import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NotificationStore } from "../notification-store.ts";
import type { Clock } from "../clock.ts";

export interface NotificationsRouteDeps {
  readonly notifications: NotificationStore;
  readonly clock: Clock;
}

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
