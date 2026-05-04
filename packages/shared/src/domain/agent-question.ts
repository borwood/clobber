import { z } from "zod";

export const QUESTION_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "timed_out",
] as const;

export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const AgentQuestionSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(1).optional(),
  status: QuestionStatusSchema,
  answer: z.string().optional(),
  asked_at: z.number().int().nonnegative(),
  answered_at: z.number().int().nonnegative().optional(),
});
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;

export const AgentAskRequestSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(1).optional(),
});
export type AgentAskRequest = z.infer<typeof AgentAskRequestSchema>;

export const AgentAnswerRequestSchema = z.object({
  question_id: z.string().min(1),
  answer: z.string().min(1),
});
export type AgentAnswerRequest = z.infer<typeof AgentAnswerRequestSchema>;
