import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeProvider } from "@clobber/runtime";
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
import type {
  ResumeTurnSuccess,
  ResumeTurnError,
  ResumeEndedResult,
} from "../resume-pipeline.ts";

interface IdParam {
  id: string;
}

interface SessionsQuery {
  workspace_id?: string;
}

const PromptBodySchema = z.object({
  prompt: z.string().min(1),
});

const ResumeBodySchema = z.object({
  prompt: z.string().optional(),
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
    runtimeProvider: RuntimeProvider;
    resumeTurn: (input: {
      readonly sessionId: string;
      readonly prompt: string;
    }) => Promise<ResumeTurnSuccess | ResumeTurnError>;
    resumeEnded: (input: {
      readonly sessionId: string;
      readonly prompt: string | undefined;
    }) => Promise<ResumeEndedResult>;
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
        if (deps.runtimeProvider.capabilities.processLifetime === "turn") {
          const resumed = await deps.resumeTurn({
            sessionId,
            prompt: parsed.data.prompt,
          });
          if (!resumed.ok) {
            reply.code(resumed.status);
            return resumed.detail === undefined
              ? { error: resumed.error }
              : { error: resumed.error, detail: resumed.detail };
          }
          return { ok: true, pid: resumed.pid };
        }
        endSession(sessionId, deps);
        reply.code(410);
        return { error: "session ended" };
      }
      if (deps.runtimeProvider.capabilities.processLifetime === "turn") {
        reply.code(409);
        return { error: "agent busy" };
      }
      if (live.busy) {
        reply.code(409);
        return { error: "agent busy" };
      }
      if (!deps.runtimeProvider.capabilities.livePromptInjection) {
        reply.code(409);
        return { error: "runtime does not support live prompt injection" };
      }
      live.stdin.write(deps.runtimeProvider.serializeUserPrompt(parsed.data.prompt));
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
    "/sessions/:id/resume",
    async (request, reply) => {
      const parsed = ResumeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid resume request", issues: parsed.error.issues };
      }
      const result = await deps.resumeEnded({
        sessionId: request.params.id,
        prompt: parsed.data.prompt,
      });
      if (!result.ok) {
        const { ok: _ok, status, ...rest } = result;
        reply.code(status);
        return rest;
      }
      return { ok: true, session_id: result.session_id, pid: result.pid };
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
      if (!deps.runtimeProvider.capabilities.interrupt) {
        reply.code(409);
        return { error: "runtime does not support interrupt" };
      }
      live.stdin.write(deps.runtimeProvider.serializeInterrupt(randomUUID()));
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
