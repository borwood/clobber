import type { FastifyInstance } from "fastify";
import { AgentAskRequestSchema, AgentAnswerRequestSchema } from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type {
  AgentQuestionWaiter,
} from "../agent-question-waiter.ts";
import { QuestionTimeoutError } from "../agent-question-waiter.ts";
import { resolveCallerSession } from "./_agent-auth.ts";

const DEFAULT_ASK_TIMEOUT_MS = 30 * 60 * 1000;

export interface AgentAskRouteDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  readonly askTimeoutMs?: number;
}

export function registerAgentAskRoutes(
  app: FastifyInstance,
  deps: AgentAskRouteDeps,
): void {
  const timeoutMs = deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  app.post("/agent/ask", async (request, reply) => {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }

    const parsed = AgentAskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid ask request", issues: parsed.error.issues };
    }

    const supersededIds = deps.agentQuestions.cancelAllForSession(auth.session.id);
    for (const id of supersededIds) {
      const row = deps.agentQuestions.get(id);
      if (row !== null) deps.agentQuestionWaiter.notify(row);
    }

    const created = deps.agentQuestions.create({
      session_id: auth.session.id,
      question: parsed.data.question,
      ...(parsed.data.options === undefined ? {} : { options: parsed.data.options }),
    });

    try {
      const resolved = await deps.agentQuestionWaiter.wait(created.id, timeoutMs);
      if (resolved.status === "answered") {
        return { resolution: "answered", answer: resolved.answer };
      }
      return { resolution: resolved.status };
    } catch (err) {
      if (err instanceof QuestionTimeoutError) {
        deps.agentQuestions.timeout(created.id);
        return { resolution: "timed_out" };
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>(
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
      if (question.status !== "pending") {
        reply.code(409);
        return { error: "question already resolved", status: question.status };
      }

      deps.agentQuestions.answer(question.id, parsed.data.answer);
      const resolved = deps.agentQuestions.get(question.id);
      if (resolved !== null) deps.agentQuestionWaiter.notify(resolved);

      return { ok: true };
    },
  );
}
