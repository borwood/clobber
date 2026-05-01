import Fastify, { type FastifyInstance } from "fastify";
import { HookPayloadSchema, type HookPayload } from "@clobber/shared";

export function createServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  const events: HookPayload[] = [];

  app.post("/hook", async (request, reply) => {
    const parsed = HookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid hook payload", issues: parsed.error.issues };
    }
    events.push(parsed.data);
    return { continue: true };
  });

  app.get("/events", async () => events);

  return app;
}
