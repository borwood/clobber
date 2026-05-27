import { z } from "zod";
import { BootContextProviderSchema } from "./boot-context-provider.ts";

// A seed is a shareable layer-B compositional unit of the session-start system
// prompt (epic #209). Two kinds:
//   static  — stored text, composed verbatim.
//   dynamic — a {noop|exec|http} provider run at spawn whose stdout composes
//             in. Reuses #166's provider runner (boot-context-provider.ts)
//             rather than inventing a parallel one (Golden Rule 1).
export const SeedStaticSchema = z.object({
  kind: z.literal("static"),
  text: z.string(),
});

export const SeedDynamicSchema = z.object({
  kind: z.literal("dynamic"),
  provider: BootContextProviderSchema,
});

export const SeedDefinitionSchema = z.discriminatedUnion("kind", [
  SeedStaticSchema,
  SeedDynamicSchema,
]);
export type SeedDefinition = z.infer<typeof SeedDefinitionSchema>;

// A catalog entry: a named seed definition. Workspace-scoped — resolved from
// shipped defaults overlaid by the filesystem catalog (<repo>/.clobber/seeds/),
// mirroring the skill catalog (#136).
export const SeedSchema = z.object({
  name: z.string().min(1),
  definition: SeedDefinitionSchema,
});
export type Seed = z.infer<typeof SeedSchema>;

// A role's reference to a catalog seed. The ref list is an ordered, versioned
// field on the role (sibling to skills/triggers); order is composition order
// and `enabled` is the per-seed toggle. Same "catalog + per-role refs" shape as
// skills/tools.
export const SeedRefSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});
export type SeedRef = z.infer<typeof SeedRefSchema>;

export const SeedRefsSchema = z.array(SeedRefSchema);
