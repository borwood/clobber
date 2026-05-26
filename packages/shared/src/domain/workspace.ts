import { z } from "zod";
import { FinalReportCallbackSchema } from "./final-report-callback.ts";
import { BootContextProviderSchema } from "./boot-context-provider.ts";
import { SpawnWorktreeSchema } from "./spawn-worktree.ts";
import { FileSizePolicySchema } from "./file-size-policy.ts";
import { ManagerSkillPolicySchema } from "./manager-skill-policy.ts";

export const SettingSourceSchema = z.enum(["user", "project", "local"]);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

// What gets passed to claude's --setting-sources. Order is irrelevant on
// the CLI side, but we de-dupe and validate at the schema layer so the
// stored value is always canonical.
export const SettingSourcesSchema = z
  .array(SettingSourceSchema)
  .refine((s) => new Set(s).size === s.length, {
    message: "setting_sources must not contain duplicates",
  });

export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = [
  "user",
  "project",
  "local",
];

export const DEFAULT_WAKE_PROMPT =
  "You have been woken without a specific task. Review your office notes, then summarise where you left off and what (if anything) needs your attention next.";

export const DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS: readonly string[] = [
  "hooks",
  "permission_mode",
];

export const RoleEditPolicySchema = z.object({
  forbidden_keys: z.array(z.string().min(1)).refine(
    (s) => new Set(s).size === s.length,
    { message: "forbidden_keys must not contain duplicates" },
  ),
});
export type RoleEditPolicy = z.infer<typeof RoleEditPolicySchema>;

// Per-role-instance trigger disable list. The id of a trigger comes from
// triggerId() in role.ts — a stable canonical form derived from the
// trigger's shape (e.g. `cron:0 9 * * *`). Empty list = nothing disabled;
// an absent entry for a role = nothing disabled. Forward-compatible: a
// future per-trigger param override (changing a cron schedule, filtering
// a webhook payload) would extend this object with additional fields.
export const TriggerOverrideSchema = z.object({
  disabled_trigger_ids: z.array(z.string().min(1)).refine(
    (s) => new Set(s).size === s.length,
    { message: "disabled_trigger_ids must not contain duplicates" },
  ),
});
export type TriggerOverride = z.infer<typeof TriggerOverrideSchema>;

export const TriggerOverridesSchema = z.record(
  z.string().uuid(),
  TriggerOverrideSchema,
);
export type TriggerOverrides = z.infer<typeof TriggerOverridesSchema>;

export const DEFAULT_TRIGGER_OVERRIDES: TriggerOverrides = {};

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema,
  wake_prompt: z.string().min(1),
  role_edit_policy: RoleEditPolicySchema,
  trigger_overrides: TriggerOverridesSchema,
  final_report_callback: FinalReportCallbackSchema,
  boot_context_provider: BootContextProviderSchema,
  spawn_worktree: SpawnWorktreeSchema,
  file_size_policy: FileSizePolicySchema,
  manager_skill_policy: ManagerSkillPolicySchema,
  created_at: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema.optional(),
  wake_prompt: z.string().min(1).optional(),
  role_edit_policy: RoleEditPolicySchema.optional(),
  trigger_overrides: TriggerOverridesSchema.optional(),
  final_report_callback: FinalReportCallbackSchema.optional(),
  boot_context_provider: BootContextProviderSchema.optional(),
  spawn_worktree: SpawnWorktreeSchema.optional(),
  file_size_policy: FileSizePolicySchema.optional(),
  manager_skill_policy: ManagerSkillPolicySchema.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceConfigRequestSchema = z
  .object({
    setting_sources: SettingSourcesSchema.optional(),
    wake_prompt: z.string().min(1).optional(),
    role_edit_policy: RoleEditPolicySchema.optional(),
    trigger_overrides: TriggerOverridesSchema.optional(),
    final_report_callback: FinalReportCallbackSchema.optional(),
    boot_context_provider: BootContextProviderSchema.optional(),
    spawn_worktree: SpawnWorktreeSchema.optional(),
    file_size_policy: FileSizePolicySchema.optional(),
    manager_skill_policy: ManagerSkillPolicySchema.optional(),
  })
  .refine(
    (v) =>
      v.setting_sources !== undefined ||
      v.wake_prompt !== undefined ||
      v.role_edit_policy !== undefined ||
      v.trigger_overrides !== undefined ||
      v.final_report_callback !== undefined ||
      v.boot_context_provider !== undefined ||
      v.spawn_worktree !== undefined ||
      v.file_size_policy !== undefined ||
      v.manager_skill_policy !== undefined,
    {
      message:
        "must include at least one of setting_sources, wake_prompt, role_edit_policy, trigger_overrides, final_report_callback, boot_context_provider, spawn_worktree, file_size_policy, manager_skill_policy",
    },
  );
export type UpdateWorkspaceConfigRequest = z.infer<
  typeof UpdateWorkspaceConfigRequestSchema
>;
