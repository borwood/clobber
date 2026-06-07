import type { FastifyInstance } from "fastify";
import {
  AgentAskRequestSchema,
  normalizeAskOptions,
  type AgentAskResponse,
  type AskQuestion,
} from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import {
  awaitExistingAnswer,
  createAndAwaitAnswer,
  type AskResolution,
} from "../agent-question-blocking.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";

// A blocking ask never expires (#241). This is the server-side long-poll
// heartbeat: each request parks for at most this long before returning
// `pending`, and the CLI re-polls the durable question. It is a cadence knob,
// not a deadline — the ask outlives any number of windows.
const DEFAULT_ASK_POLL_WINDOW_MS = 25 * 1000;

export interface AgentAskRouteDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  // #385 — present iff git-as-truth is configured; keeps the ask command's auth
  // gate commit-safe for a git-backed role.
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  readonly workspaces: Pick<WorkspaceStore, "get">;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  readonly askPollWindowMs?: number;
}

function toResponse(
  resolution: AskResolution,
  questionId: string,
): AgentAskResponse {
  if (resolution.status === "answered") {
    return { resolution: "answered", answer: resolution.answer };
  }
  if (resolution.status === "cancelled") return { resolution: "cancelled" };
  return { resolution: "pending", question_id: questionId };
}

export function registerAgentAskRoutes(
  app: FastifyInstance,
  deps: AgentAskRouteDeps,
): void {
  const windowMs = deps.askPollWindowMs ?? DEFAULT_ASK_POLL_WINDOW_MS;

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
      const { resolution, questionId } = await createAndAwaitAnswer(
        { session_id: session.id, questions: [question] },
        windowMs,
        deps,
      );
      return toResponse(resolution, questionId);
    }),
  );

  // Re-poll an already-created ask. The CLI re-attaches here each window while a
  // blocking ask is `pending`, so a dropped connection just reconnects rather
  // than converting "still waiting" into "failed".
  app.get<{ Params: { id: string } }>(
    "/agent/ask/:id",
    withAgentAuth<{ Params: { id: string } }>("ask", deps, async (request, reply, { session }) => {
      const questionId = request.params.id;
      const existing = deps.agentQuestions.get(questionId);
      if (existing === null || existing.session_id !== session.id) {
        reply.code(404);
        return { error: "question not found for session" };
      }
      const resolution = await awaitExistingAnswer(questionId, windowMs, deps);
      return toResponse(resolution, questionId);
    }),
  );
}
