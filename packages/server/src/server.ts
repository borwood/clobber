import Fastify, { type FastifyInstance } from "fastify";

export function createServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  const events: unknown[] = [];

  app.post("/hook", async (request) => {
    events.push(request.body);
    return { continue: true };
  });

  app.get("/events", async () => events);

  return app;
}
