import { z } from "zod";
import { CliScopeSchema, DEFAULT_WORKSPACE_PERMS_SCOPE, type CliScope } from "./cli-scope.ts";
import { FinalReportCallbackSchema } from "./final-report-callback.ts";
import { SpawnWorktreeSchema } from "./spawn-worktree.ts";
import { FileSizePolicySchema } from "./file-size-policy.ts";
import { WorkspaceThemeSchema } from "./workspace-theme.ts";
import { ManagerSkillPolicySchema } from "./manager-skill-policy.ts";

export { DEFAULT_WORKSPACE_PERMS_SCOPE };
export type { CliScope };

export const SettingSourceSchema = z.enum(["user", "project", "local"]);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

// What gets passed to claude's --setting-sources. Order is irrelevant on
// the CLI side, but we de-dupe and validate at the schema layer so the
// stored value is always canonical.
export const SettingSourcesSchema = z
  .array(SettingSourceSchema)
  .refine((s) => new Set(s).size === s.length, {
    message: "setting_sources must not contain duplicates",
  })
  .meta({
    title: "Claude setting sources",
    description:
      "Which Claude config layers spawned sessions load. user (~/.claude) is always on; project is the repo's .claude, local its .claude.local.",
  });

export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = [
  "user",
  "project",
  "local",
];

export const DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS: readonly string[] = [
  "hooks",
  "permission_mode",
];

export const RoleEditPolicySchema = z
  .object({
    forbidden_keys: z
      .array(z.string().min(1))
      .refine((s) => new Set(s).size === s.length, {
        message: "forbidden_keys must not contain duplicates",
      })
      .meta({ title: "Forbidden keys" }),
  })
  .meta({
    title: "Role edit policy",
    description: "Role manifest keys agents may never change when editing a role (e.g. hooks, permission_mode).",
  });
export type RoleEditPolicy = z.infer<typeof RoleEditPolicySchema>;

// Per-role-instance trigger disable list. The id of a trigger comes from
// triggerId() in role.ts — a stable canonical form derived from the
// trigger's shape (e.g. `cron:0 9 * * *`).
//
// `disabled_trigger_ids`: empty list = nothing disabled; an absent entry for a
// role = nothing disabled.
//
// `wake_programs`: per-trigger-id override of the wake-program a fired trigger
// composes, layered over the role-authored default on the trigger (`wake_program`
// in role.ts). An absent key falls through to the role default; absent both
// keeps the legacy synthesized-prompt-as-kick. This is the "future per-trigger
// param override" the original disable-only shape anticipated — optional so
// pre-existing stored overrides still parse.
export const TriggerOverrideSchema = z.object({
  disabled_trigger_ids: z.array(z.string().min(1)).refine(
    (s) => new Set(s).size === s.length,
    { message: "disabled_trigger_ids must not contain duplicates" },
  ),
  wake_programs: z.record(z.string().min(1), z.string().min(1)).optional(),
});
export type TriggerOverride = z.infer<typeof TriggerOverrideSchema>;

export const TriggerOverridesSchema = z
  .record(z.string().uuid(), TriggerOverrideSchema)
  .meta({
    title: "Trigger overrides",
    description:
      "Per-role-instance trigger disables and wake-program overrides, keyed by agent id. Edited as raw JSON for now.",
  });
export type TriggerOverrides = z.infer<typeof TriggerOverridesSchema>;

export const DEFAULT_TRIGGER_OVERRIDES: TriggerOverrides = {};

// Deterministic name → URL slug. With unique-name enforcement at create time
// this keeps name↔slug 1:1, so `/w/:slug` resolves to a workspace without a
// stored slug column. Returns "" for names with no url-safe characters; callers
// reject those (an unrouteable name).
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema,
  role_edit_policy: RoleEditPolicySchema,
  trigger_overrides: TriggerOverridesSchema,
  final_report_callback: FinalReportCallbackSchema,
  spawn_worktree: SpawnWorktreeSchema,
  file_size_policy: FileSizePolicySchema,
  manager_skill_policy: ManagerSkillPolicySchema,
  theme: WorkspaceThemeSchema,
  perms_scope: CliScopeSchema,
  created_at: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema.optional(),
  role_edit_policy: RoleEditPolicySchema.optional(),
  trigger_overrides: TriggerOverridesSchema.optional(),
  final_report_callback: FinalReportCallbackSchema.optional(),
  spawn_worktree: SpawnWorktreeSchema.optional(),
  file_size_policy: FileSizePolicySchema.optional(),
  manager_skill_policy: ManagerSkillPolicySchema.optional(),
  theme: WorkspaceThemeSchema.optional(),
  perms_scope: CliScopeSchema.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceConfigRequestSchema = z
  .object({
    setting_sources: SettingSourcesSchema.optional(),
    role_edit_policy: RoleEditPolicySchema.optional(),
    trigger_overrides: TriggerOverridesSchema.optional(),
    final_report_callback: FinalReportCallbackSchema.optional(),
    spawn_worktree: SpawnWorktreeSchema.optional(),
    file_size_policy: FileSizePolicySchema.optional(),
    manager_skill_policy: ManagerSkillPolicySchema.optional(),
    theme: WorkspaceThemeSchema.optional(),
    perms_scope: CliScopeSchema.optional(),
  })
  .refine(
    (v) =>
      v.setting_sources !== undefined ||
      v.role_edit_policy !== undefined ||
      v.trigger_overrides !== undefined ||
      v.final_report_callback !== undefined ||
      v.spawn_worktree !== undefined ||
      v.file_size_policy !== undefined ||
      v.manager_skill_policy !== undefined ||
      v.theme !== undefined ||
      v.perms_scope !== undefined,
    {
      message:
        "must include at least one of setting_sources, role_edit_policy, trigger_overrides, final_report_callback, spawn_worktree, file_size_policy, manager_skill_policy, theme, perms_scope",
    },
  );
export type UpdateWorkspaceConfigRequest = z.infer<
  typeof UpdateWorkspaceConfigRequestSchema
>;
