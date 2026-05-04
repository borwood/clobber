import { z } from "zod";

export const AGENT_STATES = ["working", "blocked", "idle", "done"] as const;

export const AgentStateSchema = z.enum(AGENT_STATES);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentStatusSchema = z.object({
  session_id: z.string().min(1),
  state: AgentStateSchema,
  summary: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  updated_at: z.number().int().nonnegative(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentStatusUpdateSchema = z.object({
  state: AgentStateSchema,
  summary: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AgentStatusUpdate = z.infer<typeof AgentStatusUpdateSchema>;

export const LatestAgentStatusSchema = z.object({
  state: AgentStateSchema,
  summary: z.string().min(1),
  updated_at: z.number().int().nonnegative(),
});
export type LatestAgentStatus = z.infer<typeof LatestAgentStatusSchema>;
