import { z } from "zod";
import type { AskOption, PreToolUsePayload } from "@clobber/shared";
import { askAndAwaitAnswer } from "./agent-question-blocking.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export const ASK_BRIDGE_TIMEOUT_NOTICE =
  "AskUserQuestion timed out; no human answer recorded";
export const ASK_BRIDGE_CANCEL_NOTICE =
  "AskUserQuestion cancelled (session ended or superseded)";

const AskUserQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
});

const AskUserQuestionInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().min(1).optional(),
        options: z.array(AskUserQuestionOptionSchema).min(2).max(4),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
});

export interface AskBridgeResponse {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "deny";
    readonly permissionDecisionReason: string;
    readonly additionalContext: string;
  };
}

export interface AskBridgeDeps {
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  readonly askTimeoutMs: number;
}

export async function bridgeAskUserQuestion(
  payload: PreToolUsePayload,
  deps: AskBridgeDeps,
): Promise<AskBridgeResponse | null> {
  if (payload.tool_name !== ASK_USER_QUESTION_TOOL) return null;

  const parsed = AskUserQuestionInputSchema.safeParse(payload.tool_input);
  if (!parsed.success) return null;

  const first = parsed.data.questions[0];
  if (first === undefined) return null;

  const options: readonly AskOption[] = first.options.map((opt) => {
    const out: AskOption = { label: opt.label };
    if (opt.description !== undefined) out.description = opt.description;
    if (opt.preview !== undefined) out.preview = opt.preview;
    return out;
  });

  const resolution = await askAndAwaitAnswer(
    {
      session_id: payload.session_id,
      question: first.question,
      ...(first.header === undefined ? {} : { header: first.header }),
      options,
      multi_select: first.multiSelect === true,
    },
    deps.askTimeoutMs,
    deps,
  );

  const reason = renderReason(parsed.data.questions.length, resolution);
  const additionalContext = renderContext(first.question, resolution);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext,
    },
  };
}

type Resolution =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "cancelled" }
  | { readonly status: "timed_out" };

function renderReason(questionCount: number, resolution: Resolution): string {
  if (resolution.status === "timed_out") return ASK_BRIDGE_TIMEOUT_NOTICE;
  if (resolution.status === "cancelled") return ASK_BRIDGE_CANCEL_NOTICE;
  const lossy =
    questionCount > 1
      ? " (note: extra AskUserQuestion questions beyond the first were dropped; resend as separate calls if needed.)"
      : "";
  return `User answered via clobber ask widget: ${resolution.answer}${lossy}`;
}

function renderContext(question: string, resolution: Resolution): string {
  if (resolution.status === "answered") {
    return [
      "The PreToolUse hook intercepted AskUserQuestion and routed it to the clobber",
      "ask widget. The human's answer is recorded below — proceed as if",
      "AskUserQuestion had returned this answer successfully:",
      "",
      `Question: ${question}`,
      `Answer:   ${resolution.answer}`,
    ].join("\n");
  }
  if (resolution.status === "timed_out") {
    return [
      "The PreToolUse hook intercepted AskUserQuestion and routed it to the clobber",
      "ask widget, but no human answered before the timeout elapsed. Decide how to",
      "proceed without the answer; ask again later via clobber ask if needed.",
    ].join("\n");
  }
  return [
    "The PreToolUse hook intercepted AskUserQuestion and routed it to the clobber",
    "ask widget, but the question was cancelled (the session ended or a newer",
    "question superseded it). Do not retry automatically.",
  ].join("\n");
}
