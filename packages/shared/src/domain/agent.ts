import { z } from "zod";

export const AgentSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  label: z.string().min(1).optional(),
  // The agent that spawned this one — the capability-holder / owner for
  // confirm-resume flows (#621). Absent for manager agents and any agent
  // spawned without a recorded spawner.
  spawner_agent_id: z.string().uuid().optional(),
  created_at: z.number().int().nonnegative(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentRequestSchema = z.object({
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  label: z.string().min(1).optional(),
  spawner_agent_id: z.string().uuid().optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
