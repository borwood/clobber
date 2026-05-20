import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TriggerScheduler } from "../trigger-scheduler.ts";

const FireBodySchema = z.object({
  path: z.string().min(1).startsWith("/"),
  payload: z.unknown().optional(),
});

export interface WebhookTriggersRouteDeps {
  readonly scheduler: Pick<TriggerScheduler, "fireWebhook">;
}

export function registerWebhookTriggersRoutes(
  app: FastifyInstance,
  deps: WebhookTriggersRouteDeps,
): void {
  app.post("/webhook-triggers", async (request, reply) => {
    const parsed = FireBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid webhook fire request", issues: parsed.error.issues };
    }
    const result = deps.scheduler.fireWebhook(
      parsed.data.path,
      parsed.data.payload,
    );
    return { dispatched: result.dispatched };
  });
}
