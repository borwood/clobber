import type { FastifyInstance } from "fastify";
import type { EventStore } from "../event-store.ts";
import type { SessionStore } from "../session-store.ts";
import { readTranscript } from "../transcript-reader.ts";

interface IdParam {
  id: string;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: { store: EventStore; sessions: SessionStore },
): void {
  app.get("/sessions", async () => deps.store.listSessions());

  app.get<{ Params: IdParam }>(
    "/sessions/:id/transcript",
    async (request, reply) => {
      const session = deps.sessions.get(request.params.id);
      if (session === null) {
        reply.code(404);
        return { error: "session not found" };
      }
      if (session.transcript_path === undefined) return [];
      return readTranscript(session.transcript_path);
    },
  );
}
