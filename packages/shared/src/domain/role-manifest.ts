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

export const CLI_COMMAND_WILDCARD = "*";

// Returns true iff `commandName` is permitted by the allow-list.
//
// Names may be plain top-level verbs (e.g. "spawn") or dotted sub-verbs
// (e.g. "roles.fork"). A list containing "*" permits any command. Sub-verb
// matching is exact: a list with ["roles.list"] permits "roles.list" but
// not "roles.fork". Future extension point: "roles.*" could allow any
// roles.<x>; not implemented yet to keep semantics narrow.
export function isCliCommandAllowed(
  allowed: readonly string[],
  commandName: string,
): boolean {
  if (allowed.includes(CLI_COMMAND_WILDCARD)) return true;
  return allowed.includes(commandName);
}
