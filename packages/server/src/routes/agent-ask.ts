import type { FastifyInstance } from "fastify";
import {
  AgentAskRequestSchema,
  AgentAnswerRequestSchema,
  normalizeAskOptions,
} from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import { askAndAwaitAnswer } from "../agent-question-blocking.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";

const DEFAULT_ASK_TIMEOUT_MS = 30 * 60 * 1000;

export interface AgentAskRouteDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  readonly askTimeoutMs?: number;
}

export function registerAgentAskRoutes(
  app: FastifyInstance,
  deps: AgentAskRouteDeps,
): void {
  const timeoutMs = deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  app.post(
    "/agent/ask",
    withAgentAuth("ask", deps, async (request, reply, { session }) => {
      const parsed = AgentAskRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid ask request", issues: parsed.error.issues };
      }

      const options = normalizeAskOptions(parsed.data.options);
      const resolution = await askAndAwaitAnswer(
        {
          session_id: session.id,
          question: parsed.data.question,
          ...(parsed.data.header === undefined ? {} : { header: parsed.data.header }),
          ...(options === undefined ? {} : { options }),
          ...(parsed.data.multi_select === undefined
            ? {}
            : { multi_select: parsed.data.multi_select }),
        },
        timeoutMs,
        deps,
      );

      if (resolution.status === "answered") {
        return { resolution: "answered", answer: resolution.answer };
      }
      return { resolution: resolution.status };
    }),
  );

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
