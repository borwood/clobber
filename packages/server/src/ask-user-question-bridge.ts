import { z } from "zod";
import {
  decodePanelAnswer,
  type AskOption,
  type AskQuestion,
  type PreToolUsePayload,
} from "@clobber/shared";
import {
  awaitAnswerBlocking,
  type AskResolution,
} from "./agent-question-blocking.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export const ASK_BRIDGE_REASON_STAMP =
  "AskUserQuestion routed through clobber ask widget — see additionalContext for the structured answer.";

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
    .min(1)
    .max(4),
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
  readonly askPollWindowMs: number;
}

// Handed to the agent verbatim when an ask resolves without an answer (the
// session ended or a newer ask superseded it). The whole point of #241: a
// delivery hiccup must never read as a broken tool, so this is a calm, trustable
// instruction — not an error.
const NO_ANSWER_NOTE =
  "No answer is available — the ask was closed (the session ended or a newer ask replaced it). " +
  "The ask channel is healthy; this is not a tool failure and your question was not lost. " +
  "Proceed using your best judgment, and ask again if you still need a decision.";

export async function bridgeAskUserQuestion(
  payload: PreToolUsePayload,
  deps: AskBridgeDeps,
): Promise<AskBridgeResponse | null> {
  if (payload.tool_name !== ASK_USER_QUESTION_TOOL) return null;

  const parsed = AskUserQuestionInputSchema.safeParse(payload.tool_input);
  if (!parsed.success) return null;

  const questions: readonly AskQuestion[] = parsed.data.questions.map((q) => ({
    question: q.question,
    ...(q.header === undefined ? {} : { header: q.header }),
    options: q.options.map(toAskOption),
    multi_select: q.multiSelect === true,
  }));

  const resolution = await awaitAnswerBlocking(
    { session_id: payload.session_id, questions },
    deps.askPollWindowMs,
    deps,
  );

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ASK_BRIDGE_REASON_STAMP,
      additionalContext: renderContext(questions, resolution),
    },
  };
}

function toAskOption(opt: z.infer<typeof AskUserQuestionOptionSchema>): AskOption {
  const out: AskOption = { label: opt.label };
  if (opt.description !== undefined) out.description = opt.description;
  if (opt.preview !== undefined) out.preview = opt.preview;
  return out;
}

interface Selection {
  readonly label: string;
  readonly option_index: number | null;
}

interface AnsweredQuestion {
  readonly question: string;
  readonly header?: string;
  readonly multi_select: boolean;
  readonly selections: readonly Selection[];
  readonly raw: string;
  readonly notes?: string;
}

interface EchoedQuestion {
  readonly question: string;
  readonly header?: string;
  readonly multi_select: boolean;
}

function renderContext(
  questions: readonly AskQuestion[],
  resolution: AskResolution,
): string {
  if (resolution.status === "answered") {
    const parts = decodePanelAnswer(resolution.answer, questions.length);
    const answers: readonly AnsweredQuestion[] = questions.map((q, i) => {
      const part = parts[i];
      if (part === undefined) throw new Error(`missing answer for question ${i}`);
      return {
        question: q.question,
        ...(q.header === undefined ? {} : { header: q.header }),
        multi_select: q.multi_select,
        selections: parseSelections(part.raw, q.options, q.multi_select),
        raw: part.raw,
        ...(part.notes === undefined ? {} : { notes: part.notes }),
      };
    });
    return JSON.stringify({ status: "answered", answers });
  }

  const echoed: readonly EchoedQuestion[] = questions.map((q) => ({
    question: q.question,
    ...(q.header === undefined ? {} : { header: q.header }),
    multi_select: q.multi_select,
  }));
  return JSON.stringify({
    status: resolution.status,
    note: NO_ANSWER_NOTE,
    questions: echoed,
  });
}

function parseSelections(
  raw: string,
  options: readonly AskOption[] | undefined,
  multiSelect: boolean,
): readonly Selection[] {
  const labels = parseAnswerLabels(raw, multiSelect);
  return labels.map((label) => {
    const idx =
      options === undefined
        ? -1
        : options.findIndex((opt) => opt.label === label);
    return { label, option_index: idx === -1 ? null : idx };
  });
}

function parseAnswerLabels(
  raw: string,
  multiSelect: boolean,
): readonly string[] {
  if (!multiSelect) return [raw];
  const parsed = tryParseJsonArrayOfStrings(raw);
  if (parsed !== null) return parsed;
  return [raw];
}

function tryParseJsonArrayOfStrings(raw: string): readonly string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return null;
  if (!parsed.every((v) => typeof v === "string" && v.length > 0)) return null;
  return parsed as readonly string[];
}
