import type { FastifyInstance } from "fastify";
import type { SessionStore } from "../session-store.ts";
import type { WorkspaceSessionSummaries } from "../workspace-session-summaries.ts";
import { readTranscript } from "../transcript-reader.ts";

interface IdParam {
  id: string;
}

interface SessionsQuery {
  workspace_id?: string;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionStore; summaries: WorkspaceSessionSummaries },
): void {
  app.get<{ Querystring: SessionsQuery }>("/sessions", async (request, reply) => {
    const workspaceId = request.query.workspace_id;
    if (workspaceId === undefined || workspaceId.length === 0) {
      reply.code(400);
      return { error: "workspace_id query param is required" };
    }
    return deps.summaries.list(workspaceId);
  });

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
