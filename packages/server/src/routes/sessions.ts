import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { serializeUserMessage } from "@clobber/runtime";
import type { SessionStore } from "../session-store.ts";
import type { WorkspaceSessionSummaries } from "../workspace-session-summaries.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { readTranscript } from "../transcript-reader.ts";

interface IdParam {
  id: string;
}

interface SessionsQuery {
  workspace_id?: string;
}

const PromptBodySchema = z.object({
  prompt: z.string().min(1),
});

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: {
    sessions: SessionStore;
    summaries: WorkspaceSessionSummaries;
    registry: AgentRegistry;
  },
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

  app.post<{ Params: IdParam }>(
    "/sessions/:id/prompt",
    async (request, reply) => {
      const parsed = PromptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid prompt", issues: parsed.error.issues };
      }
      const live = deps.registry.get(request.params.id);
      if (live === null) {
        reply.code(404);
        return { error: "session not found" };
      }
      if (live.busy) {
        reply.code(409);
        return { error: "agent busy" };
      }
      live.stdin.write(serializeUserMessage(parsed.data.prompt));
      deps.registry.setBusy(request.params.id, true);
      return { ok: true };
    },
  );
}
