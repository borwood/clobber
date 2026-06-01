import { z } from "zod";

export const QUESTION_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "timed_out",
] as const;

export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const AskOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

/**
 * One question unit inside an ask. Mirrors a single entry of the native
 * `AskUserQuestion({ questions: [...] })` tool: a prompt, an optional header
 * chip, rich options (each carrying its own `preview`), and an independent
 * `multi_select` flag.
 */
export const AskQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1).optional(),
  options: z.array(AskOptionSchema).min(1).optional(),
  multi_select: z.boolean(),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

export const AgentQuestionSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  questions: z.array(AskQuestionSchema).min(1),
  status: QuestionStatusSchema,
  answer: z.string().optional(),
  asked_at: z.number().int().nonnegative(),
  answered_at: z.number().int().nonnegative().optional(),
});
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;

const FlatOptionsSchema = z.array(z.string().min(1)).min(1);
const RichOptionsSchema = z.array(AskOptionSchema).min(1);

export const AgentAskRequestSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1).optional(),
  options: z.union([FlatOptionsSchema, RichOptionsSchema]).optional(),
  multi_select: z.boolean().optional(),
});
export type AgentAskRequest = z.infer<typeof AgentAskRequestSchema>;

export function normalizeAskOptions(
  options: readonly string[] | readonly AskOption[] | undefined,
): readonly AskOption[] | undefined {
  if (options === undefined || options.length === 0) return undefined;
  const first = options[0];
  if (typeof first === "string") {
    return (options as readonly string[]).map((label) => ({ label }));
  }
  return options as readonly AskOption[];
}

export const AgentAnswerRequestSchema = z.object({
  question_id: z.string().min(1),
  answer: z.string().min(1),
});
export type AgentAnswerRequest = z.infer<typeof AgentAnswerRequestSchema>;

/**
 * The wire shape of a blocking-ask poll. A blocking ask never expires (#241):
 * `pending` means "still waiting — re-poll", carrying the durable question id
 * the CLI re-attaches to; `answered`/`cancelled` are the two terminals. There is
 * deliberately no `timed_out` here — a poll window elapsing is not a failure.
 */
export const AgentAskResponseSchema = z.discriminatedUnion("resolution", [
  z.object({ resolution: z.literal("answered"), answer: z.string().min(1) }),
  z.object({ resolution: z.literal("cancelled") }),
  z.object({ resolution: z.literal("pending"), question_id: z.string().min(1) }),
]);
export type AgentAskResponse = z.infer<typeof AgentAskResponseSchema>;

/**
 * One question's answer as the human submitted it. `raw` is the same encoding
 * the single-question widget has always used (a bare label, a JSON array of
 * labels for multi-select, or free text). `notes` carries optional free-text
 * the human added alongside a selection — the return-path annotation slot.
 */
export const PanelAnswerPartSchema = z.object({
  raw: z.string().min(1),
  notes: z.string().min(1).optional(),
});
export type PanelAnswerPart = z.infer<typeof PanelAnswerPartSchema>;

export const PanelAnswerSchema = z.object({
  answers: z.array(PanelAnswerPartSchema).min(1),
});
export type PanelAnswer = z.infer<typeof PanelAnswerSchema>;

/**
 * Serialize a panel's per-question answers into the single `answer` string the
 * store carries. A one-question ask collapses to the bare `raw` so the
 * `clobber ask` / single-question path stays byte-identical; multi-question
 * asks use the `{ answers: [...] }` envelope.
 */
export function encodePanelAnswer(parts: readonly PanelAnswerPart[]): string {
  const single = parts[0];
  if (single === undefined) throw new Error("encodePanelAnswer: no parts");
  if (parts.length === 1 && single.notes === undefined) return single.raw;
  return JSON.stringify({ answers: parts });
}

/**
 * Inverse of {@link encodePanelAnswer}, keyed on how many questions the ask
 * carried. A single-question ask is usually a bare string, but encode emits the
 * envelope when a note rides alongside the selection — so we parse the envelope
 * when it is present and fall back to the bare string otherwise. A
 * multi-question ask requires the envelope to cover every question; a short
 * envelope is a partial answer and is rejected.
 */
export function decodePanelAnswer(
  raw: string,
  questionCount: number,
): readonly PanelAnswerPart[] {
  if (questionCount < 1) throw new Error("decodePanelAnswer: questionCount < 1");
  const envelope = tryParsePanelAnswer(raw);
  if (questionCount === 1) {
    if (envelope !== null && envelope.answers.length === 1) return envelope.answers;
    return [{ raw }];
  }
  if (envelope === null) {
    throw new Error(`decodePanelAnswer: expected an envelope of ${questionCount} answers`);
  }
  if (envelope.answers.length !== questionCount) {
    throw new Error(
      `decodePanelAnswer: expected ${questionCount} answers, got ${envelope.answers.length}`,
    );
  }
  return envelope.answers;
}

function tryParsePanelAnswer(raw: string): PanelAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PanelAnswerSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
