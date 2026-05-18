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

export const AgentQuestionSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().min(1).optional(),
  options: z.array(AskOptionSchema).min(1).optional(),
  multi_select: z.boolean(),
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
