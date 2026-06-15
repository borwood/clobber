import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentAnswerRequestSchema,
  decodePanelAnswer,
  type AgentQuestion,
} from "@clobber/shared";
import type { RuntimeProvider } from "@clobber/runtime";
import { injectPrompt } from "../inject-prompt.ts";
import type { SessionStore } from "../session-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { WorkspaceSessionSummaries } from "../workspace-session-summaries.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import { terminateSession } from "../session-lifecycle.ts";
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

const UserTurnKindSchema = z.enum([
  "wake-kick",
  "trigger",
  "ask-answer",
  "spawn-prompt",
  "live-inject",
  "interrupt-notice",
  "tool-token",
]);

// The composer (web `sendPrompt`) omits `kind` so its turn lands bare —
// bareness is the positive signal of a human-typed turn. Programmatic callers
// (CLI live-inject, internal forwarders) pass `kind` to mark the provenance.
const PromptBodySchema = z.object({
  prompt: z.string().min(1),
  kind: UserTurnKindSchema.optional(),
  attrs: z.record(z.string(), z.string()).optional(),
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

  // Workspace ids with at least one live session (`ended_at IS NULL`), across
  // every workspace — the same predicate /spawn uses. The web derives its
  // workspace tab strip from this so a window can show tabs (and reflect
  // another window's spawn activity) without polling /sessions per workspace.
  app.get("/sessions/live-workspaces", async () => {
    const ids = new Set(deps.sessions.listActive().map((s) => s.workspace_id));
    return [...ids];
  });

  app.post<{ Params: IdParam }>(
    "/sessions/:id/prompt",
    async (request, reply) => {
      const parsed = PromptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid prompt", issues: parsed.error.issues };
      }
      const tag =
        parsed.data.kind === undefined
          ? undefined
          : {
              kind: parsed.data.kind,
              ...(parsed.data.attrs === undefined ? {} : { attrs: parsed.data.attrs }),
            };
      const result = await injectPrompt(request.params.id, parsed.data.prompt, deps, tag);
      if (!result.ok) {
        reply.code(result.status);
        return result.detail === undefined
          ? { error: result.error }
          : { error: result.error, detail: result.detail };
      }
      return result.pid === undefined ? { ok: true } : { ok: true, pid: result.pid };
    },
  );

  app.post<{ Params: IdParam }>(
    "/sessions/:id/answer",
    async (request, reply) => {
      const session = deps.sessions.get(request.params.id);
      if (session === null) {
        reply.code(404);
        return { error: "session not found" };
      }

      const parsed = AgentAnswerRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid answer", issues: parsed.error.issues };
      }

      const question = deps.agentQuestions.get(parsed.data.question_id);
      if (question === null || question.session_id !== session.id) {
        reply.code(404);
        return { error: "question not found for session" };
      }

      // Reject a partial answer before it is recorded, so a short envelope
      // can't strand the ask in `answered` with nothing for the bridge to read.
      try {
        decodePanelAnswer(parsed.data.answer, question.questions.length);
      } catch {
        reply.code(400);
        return {
          error: "answer must cover every question",
          question_count: question.questions.length,
        };
      }

      // A still-pending ask resolves through the blocking waiter the asking
      // agent is parked on.
      if (question.status === "pending") {
        deps.agentQuestions.answer(question.id, parsed.data.answer);
        const resolved = deps.agentQuestions.get(question.id);
        if (resolved !== null) deps.agentQuestionWaiter.notify(resolved);
        return { ok: true };
      }

      // A timed-out ask has no waiter left — the agent moved on. Rather than
      // drop the late answer (#183), route it back into the session as a fresh
      // user message via the #113/#252 injection path, then record it so the
      // widget stops presenting as open.
      if (question.status === "timed_out") {
        const injected = await injectPrompt(
          session.id,
          formatLateAnswer(question, parsed.data.answer),
          deps,
          { kind: "ask-answer" },
        );
        if (!injected.ok) {
          reply.code(injected.status);
          return injected.detail === undefined
            ? { error: injected.error }
            : { error: injected.error, detail: injected.detail };
        }
        deps.agentQuestions.answerLate(question.id, parsed.data.answer);
        return { ok: true, routed: "injected" };
      }

      reply.code(409);
      return { error: "question already resolved", status: question.status };
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

function renderAnswerPart(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.join(", ");
  } catch {
    // raw is a bare label or free text, not a multi-select JSON array.
  }
  return raw;
}

/**
 * Reconstruct a timed-out ask + its late answer as a plain user message, so an
 * agent that already moved on can pick the thread back up from the injected
 * turn. Echoes each question alongside the human's choice (and any note) rather
 * than the bare answer the bridge would have returned inline — the agent no
 * longer has the question in immediate context.
 */
function formatLateAnswer(question: AgentQuestion, answer: string): string {
  const parts = decodePanelAnswer(answer, question.questions.length);
  const lines = question.questions.map((q, i) => {
    const part = parts[i]!;
    const choice = renderAnswerPart(part.raw);
    const note = part.notes === undefined ? "" : ` (note: ${part.notes})`;
    return `Q: ${q.question}\nA: ${choice}${note}`;
  });
  return [
    "[Late answer to an earlier question that had timed out]",
    ...lines,
  ].join("\n\n");
}
