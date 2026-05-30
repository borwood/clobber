import type { FastifyInstance } from "fastify";
import {
  AgentAskRequestSchema,
  normalizeAskOptions,
  type AskQuestion,
} from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
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
  // #385 — present iff git-as-truth is configured; keeps the ask command's auth
  // gate commit-safe for a git-backed role.
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
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
      const question: AskQuestion = {
        question: parsed.data.question,
        multi_select: parsed.data.multi_select === true,
        ...(parsed.data.header === undefined ? {} : { header: parsed.data.header }),
        ...(options === undefined ? {} : { options: [...options] }),
      };
      const resolution = await askAndAwaitAnswer(
        { session_id: session.id, questions: [question] },
        timeoutMs,
        deps,
      );

      if (resolution.status === "answered") {
        return { resolution: "answered", answer: resolution.answer };
      }
      return { resolution: resolution.status };
    }),
  );
}
