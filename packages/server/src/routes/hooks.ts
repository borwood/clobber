import type { FastifyInstance } from "fastify";
import { HookPayloadSchema } from "@clobber/shared";
import type { EventStore } from "../event-store.ts";

export function registerHookRoutes(
  app: FastifyInstance,
  deps: { store: EventStore },
): void {
  app.post("/hook", async (request, reply) => {
    const parsed = HookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid hook payload", issues: parsed.error.issues };
    }
    deps.store.append(parsed.data);
    return { continue: true };
  });
}
