import { z } from "zod";
import { PermissionModeSchema } from "../hooks/payloads.ts";
import { EffortLevelSchema, ModelSchema, SdlcProfileSchema } from "./role.ts";
import { SeedRefSchema } from "./seed.ts";
import { WakeProgramSchema } from "./wake-program.ts";

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
    // Layer A — the role-unique identity header, kept separate from the
    // static system prompt so it composes ahead of seeds and wake-programs.
    framingPath: RelativeBundlePath.optional(),
    pluginTemplatePath: RelativeBundlePath,
    allowedCliCommands: z.array(z.string().min(1)).readonly(),
    persistent: z.boolean(),
    defaultCeiling: z.number().int().nonnegative(),
    permissionMode: PermissionModeSchema.optional(),
    allowedTools: z.array(z.string().min(1)).readonly().optional(),
    effort: EffortLevelSchema.optional(),
    model: ModelSchema.optional(),
    sdlc: SdlcProfileSchema.optional(),
    // Layer B — the role's default, ordered seed references. Each names a
    // catalog seed and carries its enable toggle; snapshotted into the role
    // version's seed_refs_json at seed time.
    seedRefs: z.array(SeedRefSchema).readonly().optional(),
    // The role's opening moves. Each owns a layer-C system addon and an opening
    // user-message kick; snapshotted into the role version's wake_programs_json
    // at seed time. `idle` is the universal built-in and is never listed here.
    wakePrograms: z.array(WakeProgramSchema).readonly().optional(),
    // The opening move a fresh spawn selects when it names none (#213). A
    // program name from `wakePrograms` (or `idle`). Omitted → idle. The worker
    // sets `task`; the manager omits it so spawns default to idle.
    defaultWakeProgram: z.string().min(1).optional(),
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
