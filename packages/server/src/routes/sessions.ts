import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { serializeUserMessage } from "@clobber/runtime";
import type { SessionStore } from "../session-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { WorkspaceSessionSummaries } from "../workspace-session-summaries.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import { readTranscript } from "../transcript-reader.ts";
import { endSession } from "../session-lifecycle.ts";

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
    agents: AgentStore;
    roles: RoleStore;
    sessionTokens: SessionTokenStore;
    summaries: WorkspaceSessionSummaries;
    registry: AgentRegistry;
    agentQuestions: AgentQuestionStore;
    agentQuestionWaiter: AgentQuestionWaiter;
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

  app.post<{ Params: IdParam }>(
    "/sessions/:id/end",
    async (request, reply) => {
      const session = deps.sessions.get(request.params.id);
      if (session === null) {
        reply.code(404);
        return { error: "session not found" };
      }
      const live = deps.registry.get(request.params.id);
      if (live !== null) {
        live.stdin.end();
        deps.registry.unregister(request.params.id);
      }
      endSession(request.params.id, deps);
      return { ok: true };
    },
  );
}
