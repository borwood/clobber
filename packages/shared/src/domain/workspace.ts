import { z } from "zod";

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  repo_path: z.string().min(1),
  created_at: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
  repo_path: z.string().min(1),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
