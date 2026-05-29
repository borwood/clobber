import type { FastifyInstance } from "fastify";
import type { SequencedLayoutEvent } from "@clobber/shared";
import type { LayoutEventStore } from "../layout-event-store.ts";

interface IdParam {
  id: string;
}

interface SinceQuery {
  since?: string;
}

/**
 * The web half of the server→web layout bridge (#326). The layout provider
 * subscribes by polling this over the same HTTP transport every other live view
 * uses; there is no separate socket. Clients pass `?since=<seq>` and apply only
 * events past their own cursor.
 */
export function registerLayoutEventRoutes(
  app: FastifyInstance,
  deps: { layoutEvents: LayoutEventStore },
): void {
  app.get<{ Params: IdParam; Querystring: SinceQuery }>(
    "/workspaces/:id/layout-events",
    async (request): Promise<readonly SequencedLayoutEvent[]> => {
      const since = Number(request.query.since ?? "0");
      return deps.layoutEvents.since(request.params.id, since);
    },
  );
}
