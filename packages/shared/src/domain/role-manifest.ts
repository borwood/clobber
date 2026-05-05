import { z } from "zod";
import { PermissionModeSchema } from "../hooks/payloads.ts";

const RelativeBundlePath = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("/"), {
    message: "must be a relative path (no leading '/')",
  })
  .refine((s) => !s.split("/").includes(".."), {
    message: "must not contain '..' segments",
  });

export const RoleManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    systemPromptPath: RelativeBundlePath,
    pluginTemplatePath: RelativeBundlePath,
    allowedCliCommands: z.array(z.string().min(1)).readonly(),
    persistent: z.boolean(),
    defaultCeiling: z.number().int().nonnegative(),
    permissionMode: PermissionModeSchema.optional(),
    allowedTools: z.array(z.string().min(1)).readonly().optional(),
  })
  .refine(
    (m) =>
      new Set(m.allowedCliCommands).size === m.allowedCliCommands.length,
    { message: "allowedCliCommands must be unique", path: ["allowedCliCommands"] },
  );
export type RoleManifest = z.infer<typeof RoleManifestSchema>;
