import { z } from "zod";
import { PermissionModeSchema } from "../hooks/payloads.ts";
import { SeedRefSchema } from "./seed.ts";
import { WakeProgramSchema } from "./wake-program.ts";

// Reasoning depth knob exposed by `claude --effort <level>`. Mirrors the
// upstream CLI's enum — kept in lockstep with what the runtime can pass through.
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const SdlcPhaseSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, {
      message: "must be lowercase kebab-case (a–z, 0–9, hyphen, leading letter)",
    }),
  label: z.string().min(1),
  description: z.string().min(1),
});
export type SdlcPhase = z.infer<typeof SdlcPhaseSchema>;

export const SdlcProfileSchema = z
  .object({
    phases: z.array(SdlcPhaseSchema).min(1).readonly(),
    defaultStartingPhase: z.string().min(1),
    reportCliCommand: z.string().min(1).optional(),
  })
  .refine(
    (p) =>
      new Set(p.phases.map((ph) => ph.id)).size === p.phases.length,
    { message: "phase ids must be unique", path: ["phases"] },
  )
  .refine(
    (p) => p.phases.some((ph) => ph.id === p.defaultStartingPhase),
    {
      message: "defaultStartingPhase must reference an id present in phases",
      path: ["defaultStartingPhase"],
    },
  );
export type SdlcProfile = z.infer<typeof SdlcProfileSchema>;

export const RoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  permission_mode: PermissionModeSchema.optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  effort: EffortLevelSchema.optional(),
  persistent: z.boolean(),
  workspace_id: z.string().uuid().optional(),
  current_version_id: z.string().uuid().optional(),
  created_at: z.number().int().nonnegative(),
});
export type Role = z.infer<typeof RoleSchema>;

export const RoleSkillSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
});
export type RoleSkill = z.infer<typeof RoleSkillSchema>;

export const CronTriggerSchema = z.object({
  kind: z.literal("cron"),
  expr: z.string().min(1),
});
export const FileWatchTriggerSchema = z.object({
  kind: z.literal("file-watch"),
  glob: z.string().min(1),
});
export const WebhookTriggerSchema = z.object({
  kind: z.literal("webhook"),
  path: z.string().min(1).startsWith("/"),
});
export const IssueAssignedTriggerSchema = z.object({
  kind: z.literal("issue-assigned"),
  repo: z.string().min(1).optional(),
});
export const WorkspaceOpenTriggerSchema = z.object({
  kind: z.literal("workspace-open"),
  debounce_ms: z.number().int().nonnegative().optional(),
});
// Fires when any session in the workspace ends (clean exit, crash, or kill),
// sourced from the reaper's callers — the cross-agent "a worker finished" wake.
// A persistent role (the manager) declaring it gets woken with the finished
// session's outcome rebuilt from persistent state. See #171.
export const SessionEndedTriggerSchema = z.object({
  kind: z.literal("session-ended"),
});
// Fires when a worker declares itself finished via `clobber status done` —
// the worker's own terminal handoff. Unlike `session-ended` (process
// termination), this fires on the happy path where a worker opens a PR and
// idles without ending. A persistent role declaring it gets woken with the
// finished worker's done-summary, subject to the same flush-on-idle busy
// policy. See #240.
export const WorkerDoneTriggerSchema = z.object({
  kind: z.literal("worker-done"),
});
export const RoleTriggerSchema = z.discriminatedUnion("kind", [
  CronTriggerSchema,
  FileWatchTriggerSchema,
  WebhookTriggerSchema,
  IssueAssignedTriggerSchema,
  WorkspaceOpenTriggerSchema,
  SessionEndedTriggerSchema,
  WorkerDoneTriggerSchema,
]);
export type RoleTrigger = z.infer<typeof RoleTriggerSchema>;

// Triggers have no native id — they are identified by their canonical
// shape. The id is what workspace config refers to when disabling a
// specific trigger on a specific role-instance. Forward-compatible:
// adding a new kind means extending this switch with a new prefix.
export function triggerId(trigger: RoleTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return `cron:${trigger.expr}`;
    case "webhook":
      return `webhook:${trigger.path}`;
    case "file-watch":
      return `file-watch:${trigger.glob}`;
    case "issue-assigned":
      return trigger.repo === undefined
        ? "issue-assigned"
        : `issue-assigned:${trigger.repo}`;
    case "workspace-open":
      return "workspace-open";
    case "session-ended":
      return "session-ended";
    case "worker-done":
      return "worker-done";
  }
}

export const RoleVersionSchema = z.object({
  id: z.string().uuid(),
  role_id: z.string().uuid(),
  version: z.number().int().positive(),
  framing: z.string(),
  system_prompt: z.string().min(1),
  skills_json: z.string(),
  allowed_tools_json: z.string(),
  allowed_cli_commands_json: z.string(),
  hooks_json: z.string(),
  triggers_json: z.string(),
  seed_refs_json: z.string(),
  wake_programs_json: z.string(),
  created_at: z.number().int().nonnegative(),
});
export type RoleVersion = z.infer<typeof RoleVersionSchema>;

export const CreateRoleRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  permission_mode: PermissionModeSchema.optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  effort: EffortLevelSchema.optional(),
  persistent: z.boolean(),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

export const WorkspaceRoleCeilingSchema = z.object({
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  max_concurrent: z.number().int().nonnegative(),
});
export type WorkspaceRoleCeiling = z.infer<typeof WorkspaceRoleCeilingSchema>;

export const SetWorkspaceRoleCeilingRequestSchema = z.object({
  max_concurrent: z.number().int().nonnegative(),
});
export type SetWorkspaceRoleCeilingRequest = z.infer<
  typeof SetWorkspaceRoleCeilingRequestSchema
>;

export const RoleVersionRefSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
});
export type RoleVersionRef = z.infer<typeof RoleVersionRefSchema>;

export const WorkspaceRoleAssignmentSchema = z.object({
  role: RoleSchema,
  max_concurrent: z.number().int().nonnegative(),
  current_version: RoleVersionRefSchema.optional(),
});
export type WorkspaceRoleAssignment = z.infer<typeof WorkspaceRoleAssignmentSchema>;

export const RoleListEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  persistent: z.boolean(),
  description: z.string().min(1).optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  current_version_id: z.string().uuid(),
  version: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
});
export type RoleListEntry = z.infer<typeof RoleListEntrySchema>;

export const RolesListResponseSchema = z.object({
  roles: z.array(RoleListEntrySchema),
});
export type RolesListResponse = z.infer<typeof RolesListResponseSchema>;

export const RoleDetailVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  framing: z.string(),
  system_prompt: z.string().min(1),
  skills: z.array(RoleSkillSchema),
  allowed_tools: z.array(z.string().min(1)),
  hooks: z.unknown(),
  triggers: z.array(RoleTriggerSchema),
  seed_refs: z.array(SeedRefSchema),
  wake_programs: z.array(WakeProgramSchema),
  created_at: z.number().int().nonnegative(),
});
export type RoleDetailVersion = z.infer<typeof RoleDetailVersionSchema>;

export const RoleVersionHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
});
export type RoleVersionHistoryEntry = z.infer<typeof RoleVersionHistoryEntrySchema>;

export const RoleDetailResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  persistent: z.boolean(),
  description: z.string().min(1).optional(),
  current_version: RoleDetailVersionSchema,
  version_history: z.array(RoleVersionHistoryEntrySchema),
});
export type RoleDetailResponse = z.infer<typeof RoleDetailResponseSchema>;
