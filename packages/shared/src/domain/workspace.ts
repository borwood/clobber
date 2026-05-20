import { z } from "zod";

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

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema,
  wake_prompt: z.string().min(1),
  role_edit_policy: RoleEditPolicySchema,
  created_at: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema.optional(),
  wake_prompt: z.string().min(1).optional(),
  role_edit_policy: RoleEditPolicySchema.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceConfigRequestSchema = z
  .object({
    setting_sources: SettingSourcesSchema.optional(),
    wake_prompt: z.string().min(1).optional(),
    role_edit_policy: RoleEditPolicySchema.optional(),
  })
  .refine(
    (v) =>
      v.setting_sources !== undefined ||
      v.wake_prompt !== undefined ||
      v.role_edit_policy !== undefined,
    {
      message:
        "must include at least one of setting_sources, wake_prompt, role_edit_policy",
    },
  );
export type UpdateWorkspaceConfigRequest = z.infer<
  typeof UpdateWorkspaceConfigRequestSchema
>;
