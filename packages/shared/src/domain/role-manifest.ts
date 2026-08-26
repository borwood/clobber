import { z } from "zod";
import { PermissionModeSchema } from "../hooks/payloads.ts";
import { isActionAllowed } from "./cli-scope.ts";
import { EffortLevelSchema, ModelSchema, SdlcProfileSchema } from "./role.ts";
import { PromptModuleRefSchema } from "./prompt-module.ts";
import { WakeProgramSchema } from "./wake-program.ts";
import { RoleTriggerSchema } from "./role-trigger.ts";

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
    // Layer B — the role's default, ordered prompt-module references. Each names
    // a catalog module and carries its enable toggle; snapshotted into the role
    // version's seed_refs_json at seed time.
    promptModuleRefs: z.array(PromptModuleRefSchema).readonly().optional(),
    // The role's opening moves. Each owns a layer-C system addon and an opening
    // user-message kick; snapshotted into the role version's wake_programs_json
    // at seed time. `idle` is the universal built-in and is never listed here.
    wakePrograms: z.array(WakeProgramSchema).readonly().optional(),
    // The role's default wake conditions (persistent roles only), sibling to
    // promptModuleRefs/wakePrograms: snapshotted into the role version's
    // triggers_json at seed time. Absent → no default triggers (today's
    // shipped-role behavior).
    triggers: z.array(RoleTriggerSchema).readonly().optional(),
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

// Thin shim: forwards to isActionAllowed (Track C Step 3, #560).
// Unknown bare tokens (e.g. "roles") resolve to the empty grant — matches the
// old includes() semantics so agent-roles-dotted-commands.test.ts stays green.
// Deny list is always empty here; multi-tier deny is Step 4/5.
export function isCliCommandAllowed(
  allowed: readonly string[],
  commandName: string,
): boolean {
  return isActionAllowed({ allow: allowed, deny: [] }, commandName);
}
