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
import { endSession, terminateSession } from "../session-lifecycle.ts";
import { appendTranscriptNotification } from "../transcript-marker.ts";

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
    return deps.summaries.list(workspaceId).map((s) => ({
      ...s,
      busy: deps.registry.get(s.session_id)?.busy === true,
    }));
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
      const sessionId = request.params.id;
      const session = deps.sessions.get(sessionId);
      if (session === null) {
        reply.code(404);
        return { error: "session not found" };
      }
      if (session.ended_at !== undefined) {
        reply.code(410);
        return { error: "session ended" };
      }
      const live = deps.registry.get(sessionId);
      // Registry empty for an un-ended row means the child died but the exit
      // handler hasn't reaped yet (or this is a reboot orphan the boot reaper
      // missed). Either way, treat the session as gone — reap now so the
      // sidebar settles on the next poll.
      if (live === null) {
        endSession(sessionId, deps);
        reply.code(410);
        return { error: "session ended" };
      }
      if (live.busy) {
        reply.code(409);
        return { error: "agent busy" };
      }
      live.stdin.write(serializeUserMessage(parsed.data.prompt));
      deps.registry.setBusy(sessionId, true);
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
      terminateSession(request.params.id, deps);
      return { ok: true };
    },
  );

  app.post<{ Params: IdParam }>(
    "/sessions/:id/interrupt",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = deps.sessions.get(sessionId);
      if (session === null) {
        reply.code(404);
        return { error: "session not found" };
      }
      if (session.ended_at !== undefined) {
        reply.code(410);
        return { error: "session ended" };
      }
      const live = deps.registry.get(sessionId);
      if (live === null) {
        reply.code(409);
        return { error: "agent not running" };
      }
      if (!live.busy) {
        reply.code(409);
        return { error: "agent idle" };
      }
      live.kill("SIGINT");
      deps.registry.setBusy(sessionId, false);
      if (session.transcript_path !== undefined) {
        appendTranscriptNotification(
          session.transcript_path,
          "interrupted",
          "Interrupted by user",
        );
      }
      return { ok: true };
    },
  );
}
