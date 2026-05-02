import { z } from "zod";

export const AgentSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  label: z.string().min(1).optional(),
  created_at: z.number().int().nonnegative(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentRequestSchema = z.object({
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  label: z.string().min(1).optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
