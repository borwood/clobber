import type { AskQuestion } from "@clobber/shared";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import {
  QuestionTimeoutError,
  type AgentQuestionWaiter,
} from "./agent-question-waiter.ts";

export type AskResolution =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "cancelled" }
  | { readonly status: "timed_out" };

export interface AskQuestionInput {
  readonly session_id: string;
  readonly questions: readonly AskQuestion[];
}

export interface AskBlockingDeps {
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
}

export async function askAndAwaitAnswer(
  input: AskQuestionInput,
  timeoutMs: number,
  deps: AskBlockingDeps,
): Promise<AskResolution> {
  const supersededIds = deps.agentQuestions.cancelAllForSession(input.session_id);
  for (const id of supersededIds) {
    const row = deps.agentQuestions.get(id);
    if (row !== null) deps.agentQuestionWaiter.notify(row);
  }

  const created = deps.agentQuestions.create({
    session_id: input.session_id,
    questions: input.questions,
  });

  try {
    const resolved = await deps.agentQuestionWaiter.wait(created.id, timeoutMs);
    if (resolved.status === "answered") {
      const answer = resolved.answer;
      if (answer === undefined) {
        throw new Error("resolved=answered but answer field is missing");
      }
      return { status: "answered", answer };
    }
    if (resolved.status === "cancelled") return { status: "cancelled" };
    return { status: "timed_out" };
  } catch (err) {
    if (err instanceof QuestionTimeoutError) {
      deps.agentQuestions.timeout(created.id);
      return { status: "timed_out" };
    }
    throw err;
  }
}
