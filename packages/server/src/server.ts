import Fastify, { type FastifyInstance } from "fastify";
import { HookPayloadSchema } from "@clobber/shared";
import type { EventStore } from "./event-store.ts";

export interface ServerOptions {
  readonly store: EventStore;
}

interface EventsQuery {
  session_id?: string;
}

export function createServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store } = opts;

  app.post("/hook", async (request, reply) => {
    const parsed = HookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid hook payload", issues: parsed.error.issues };
    }
    store.append(parsed.data);
    return { continue: true };
  });

  app.get<{ Querystring: EventsQuery }>("/events", async (request) => {
    const { session_id } = request.query;
    return store.list(session_id ? { session_id } : undefined);
  });

  app.get("/sessions", async () => store.listSessions());

  return app;
}
