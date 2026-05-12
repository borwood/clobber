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

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema,
  created_at: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
  repo_path: z.string().min(1),
  setting_sources: SettingSourcesSchema.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceConfigRequestSchema = z.object({
  setting_sources: SettingSourcesSchema,
});
export type UpdateWorkspaceConfigRequest = z.infer<
  typeof UpdateWorkspaceConfigRequestSchema
>;
