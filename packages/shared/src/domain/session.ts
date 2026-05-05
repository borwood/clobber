import { z } from "zod";

export const SessionSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  role_version_id: z.string().uuid().optional(),
  pid: z.number().int().positive(),
  started_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative().optional(),
  transcript_path: z.string().min(1).optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionRequestSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  role_version_id: z.string().uuid().optional(),
  pid: z.number().int().positive(),
  transcript_path: z.string().min(1).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
