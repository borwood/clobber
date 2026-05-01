import type { FastifyInstance } from "fastify";
import type { EventStore } from "../event-store.ts";

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: { store: EventStore },
): void {
  app.get("/sessions", async () => deps.store.listSessions());
}
