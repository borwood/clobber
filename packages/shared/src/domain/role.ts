import { z } from "zod";
import { PermissionModeSchema } from "../hooks/payloads.ts";

export const RoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  permission_mode: PermissionModeSchema.optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  persistent: z.boolean(),
  created_at: z.number().int().nonnegative(),
});
export type Role = z.infer<typeof RoleSchema>;

export const CreateRoleRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  permission_mode: PermissionModeSchema.optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
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

export const WorkspaceRoleAssignmentSchema = z.object({
  role: RoleSchema,
  max_concurrent: z.number().int().nonnegative(),
});
export type WorkspaceRoleAssignment = z.infer<typeof WorkspaceRoleAssignmentSchema>;
