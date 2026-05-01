import type { FastifyInstance } from "fastify";
import type { EventStore } from "../event-store.ts";

interface EventsQuery {
  session_id?: string;
}

export function registerEventRoutes(
  app: FastifyInstance,
  deps: { store: EventStore },
): void {
  app.get<{ Querystring: EventsQuery }>("/events", async (request) => {
    const { session_id } = request.query;
    return deps.store.list(session_id ? { session_id } : undefined);
  });
}
