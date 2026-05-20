import { z } from "zod";
import type { AskOption, PreToolUsePayload } from "@clobber/shared";
import {
  askAndAwaitAnswer,
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

  const multiSelect = first.multiSelect === true;
  const resolution = await askAndAwaitAnswer(
    {
      session_id: payload.session_id,
      question: first.question,
      ...(first.header === undefined ? {} : { header: first.header }),
      options,
      multi_select: multiSelect,
    },
    deps.askTimeoutMs,
    deps,
  );

  const droppedCount = parsed.data.questions.length - 1;
  const additionalContext = renderContext(
    {
      question: first.question,
      ...(first.header === undefined ? {} : { header: first.header }),
    },
    options,
    multiSelect,
    droppedCount,
    resolution,
  );

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ASK_BRIDGE_REASON_STAMP,
      additionalContext,
    },
  };
}

interface Selection {
  readonly label: string;
  readonly option_index: number | null;
}

interface AnsweredContext {
  readonly status: "answered";
  readonly question: string;
  readonly header?: string;
  readonly multi_select: boolean;
  readonly selections: readonly Selection[];
  readonly raw: string;
  readonly dropped_question_count?: number;
  readonly notes?: readonly string[];
}

interface UnresolvedContext {
  readonly status: "timed_out" | "cancelled";
  readonly question: string;
  readonly header?: string;
  readonly multi_select: boolean;
  readonly dropped_question_count?: number;
  readonly notes?: readonly string[];
}

function renderContext(
  question: { readonly question: string; readonly header?: string },
  options: readonly AskOption[],
  multiSelect: boolean,
  droppedCount: number,
  resolution: AskResolution,
): string {
  const notes = collectNotes(droppedCount);

  if (resolution.status === "answered") {
    const ctx: AnsweredContext = {
      status: "answered",
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      multi_select: multiSelect,
      selections: parseSelections(resolution.answer, options, multiSelect),
      raw: resolution.answer,
      ...(droppedCount > 0 ? { dropped_question_count: droppedCount } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
    return JSON.stringify(ctx);
  }

  const ctx: UnresolvedContext = {
    status: resolution.status,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    multi_select: multiSelect,
    ...(droppedCount > 0 ? { dropped_question_count: droppedCount } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
  return JSON.stringify(ctx);
}

function collectNotes(droppedCount: number): readonly string[] {
  if (droppedCount === 0) return [];
  return [
    `${droppedCount} extra AskUserQuestion question${droppedCount === 1 ? "" : "s"} beyond the first were dropped; resend as separate calls if needed.`,
  ];
}

function parseSelections(
  raw: string,
  options: readonly AskOption[],
  multiSelect: boolean,
): readonly Selection[] {
  const labels = parseAnswerLabels(raw, multiSelect);
  return labels.map((label) => {
    const idx = options.findIndex((opt) => opt.label === label);
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
