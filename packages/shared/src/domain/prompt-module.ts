import { z } from "zod";
import { BootContextProviderSchema } from "./boot-context-provider.ts";

// A prompt-module is a shareable layer-B compositional unit of the session-start
// system prompt (epic #209). Two kinds:
//   static  — stored text, composed verbatim.
//   dynamic — a {noop|exec|http} provider run at spawn whose stdout composes
//             in. Reuses #166's provider runner (boot-context-provider.ts)
//             rather than inventing a parallel one (Golden Rule 1).
export const PromptModuleStaticSchema = z.object({
  kind: z.literal("static"),
  text: z.string(),
});

export const PromptModuleDynamicSchema = z.object({
  kind: z.literal("dynamic"),
  provider: BootContextProviderSchema,
});

export const PromptModuleDefinitionSchema = z.discriminatedUnion("kind", [
  PromptModuleStaticSchema,
  PromptModuleDynamicSchema,
]);
export type PromptModuleDefinition = z.infer<typeof PromptModuleDefinitionSchema>;

// A catalog entry: a named prompt-module definition. Workspace-scoped — resolved
// from shipped defaults overlaid by the filesystem catalog
// (<repo>/.clobber/prompt-modules/), mirroring the skill catalog (#136).
export const PromptModuleSchema = z.object({
  name: z.string().min(1),
  definition: PromptModuleDefinitionSchema,
});
export type PromptModule = z.infer<typeof PromptModuleSchema>;

// A role's reference to a catalog prompt-module. The ref list is an ordered,
// versioned field on the role (sibling to skills/triggers); order is composition
// order and `enabled` is the per-module toggle. Same "catalog + per-role refs"
// shape as skills/tools.
export const PromptModuleRefSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});
export type PromptModuleRef = z.infer<typeof PromptModuleRefSchema>;

export const PromptModuleRefsSchema = z.array(PromptModuleRefSchema);
