import type { AgentQuestion, AskQuestion } from "@clobber/shared";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";

/**
 * A blocking ask resolves to one of three states. `pending` is not a failure —
 * it means the current poll window elapsed and the ask is still live; the caller
 * re-polls. The only terminals are `answered` and `cancelled` (session ended or
 * superseded). A blocking ask has no deadline (#241), so nothing here ever times
 * the ask out.
 */
export type AskResolution =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "cancelled" }
  | { readonly status: "pending" };

export interface AskQuestionInput {
  readonly session_id: string;
  readonly questions: readonly AskQuestion[];
}

export interface AskBlockingDeps {
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
}

/**
 * Supersede any open ask for the session, create the new one, and wait a single
 * poll window. Returns the resolution plus the durable question id the caller
 * (the CLI) re-attaches to while it is `pending`.
 */
export async function createAndAwaitAnswer(
  input: AskQuestionInput,
  windowMs: number,
  deps: AskBlockingDeps,
): Promise<{ readonly resolution: AskResolution; readonly questionId: string }> {
  const supersededIds = deps.agentQuestions.cancelAllForSession(input.session_id);
  for (const id of supersededIds) {
    const row = deps.agentQuestions.get(id);
    if (row !== null) deps.agentQuestionWaiter.notify(row);
  }

  const created = deps.agentQuestions.create({
    session_id: input.session_id,
    questions: input.questions,
  });
  const resolution = await awaitExistingAnswer(created.id, windowMs, deps);
  return { resolution, questionId: created.id };
}

/**
 * Wait one poll window on an already-created question. Resolves immediately if
 * the question is already terminal (an answer that raced in between polls), so a
 * notify landing in the gap between two polls is never lost.
 */
export async function awaitExistingAnswer(
  questionId: string,
  windowMs: number,
  deps: AskBlockingDeps,
): Promise<AskResolution> {
  const before = resolveTerminal(questionId, deps);
  if (before !== null) return before;

  const outcome = await deps.agentQuestionWaiter.wait(questionId, windowMs);
  if (outcome.status === "notified") return fromRow(outcome.question);

  // The window elapsed. Re-check the store in case an answer notified the row
  // right as the window timer fired (a notify that found no live waiter).
  const after = resolveTerminal(questionId, deps);
  if (after !== null) return after;
  return { status: "pending" };
}

/**
 * Block until the ask reaches a terminal state, re-arming each poll window. Used
 * by the `AskUserQuestion` bridge, whose single hook request stays parked until
 * the human answers (or the session ends) — it has no client to re-poll for it.
 */
export async function awaitAnswerBlocking(
  input: AskQuestionInput,
  windowMs: number,
  deps: AskBlockingDeps,
): Promise<AskResolution> {
  const { resolution, questionId } = await createAndAwaitAnswer(input, windowMs, deps);
  let current = resolution;
  while (current.status === "pending") {
    current = await awaitExistingAnswer(questionId, windowMs, deps);
  }
  return current;
}

function resolveTerminal(
  questionId: string,
  deps: AskBlockingDeps,
): AskResolution | null {
  const row = deps.agentQuestions.get(questionId);
  if (row === null) throw new Error(`question ${questionId} vanished while waiting`);
  if (row.status === "pending") return null;
  return fromRow(row);
}

function fromRow(row: AgentQuestion): AskResolution {
  if (row.status === "answered") {
    if (row.answer === undefined) {
      throw new Error("resolved=answered but answer field is missing");
    }
    return { status: "answered", answer: row.answer };
  }
  // `cancelled` (session end / superseded) and any legacy `timed_out` row both
  // mean "no live answer for the agent parked here" — surface as cancelled.
  return { status: "cancelled" };
}
