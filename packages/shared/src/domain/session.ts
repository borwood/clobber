import { z } from "zod";
import { CommitRefSchema, EffortLevelSchema, ModelSchema } from "./role.ts";

export const SessionSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  // The embodied commit pin (#349): captures the sha spawned with so resume
  // re-resolves the same content even if the role's current pointer advances.
  role_commit: CommitRefSchema.optional(),
  runtime_provider: z.string().min(1),
  provider_thread_id: z.string().min(1).optional(),
  // The wake-program this session was embodied with. Persisted so resume
  // re-composes the same layer-C addon (the kick is still suppressed on resume).
  wake_program: z.string().min(1).optional(),
  // The op-level system addon injected by the cycle operation (#502). Persisted
  // so resume re-composes the same orientation layer independently of the
  // wake-program. Absent on sessions started by spawn (not cycle).
  op_level_addon: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  started_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative().optional(),
  transcript_path: z.string().min(1).optional(),
  // Set when boot reconciliation finds this session still active from a
  // previous server process — it was live when clobber last closed. The UI
  // surfaces these as resume candidates. Cleared when the session is resumed.
  was_live_at_shutdown: z.boolean().optional(),
  // The full clobber-composed `appendSystemPrompt` this session was spawned
  // with — the rendered prompt, not the role-version template. Re-captured on
  // each wake so per-session deltas are auditable (#253).
  composed_system_prompt: z.string().min(1).optional(),
  // The resolved (effective) model and effort at spawn time. Captured so the
  // session header shows the actual values used, not the role's current defaults
  // which can differ under per-dispatch overrides (#468).
  model: ModelSchema.optional(),
  effort: EffortLevelSchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionRequestSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  role_commit: CommitRefSchema.optional(),
  runtime_provider: z.string().min(1).optional(),
  provider_thread_id: z.string().min(1).optional(),
  wake_program: z.string().min(1).optional(),
  op_level_addon: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  transcript_path: z.string().min(1).optional(),
  composed_system_prompt: z.string().min(1).optional(),
  model: ModelSchema.optional(),
  effort: EffortLevelSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
