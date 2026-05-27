import type { BootContext, Seed, SeedRef } from "@clobber/shared";
import { runBootContextProvider } from "./boot-context-provider.ts";

// Resolves a role's ordered, toggleable seed references against the workspace
// catalog and composes each into a layer-B segment, in ref order. A static seed
// contributes its stored text; a dynamic seed contributes its provider's stdout
// run with the spawn env present. Disabled refs drop out. An enabled ref to a
// seed absent from the catalog is unexpected data → throw (no defensive skip).
export async function composeSeeds(
  refs: readonly SeedRef[],
  catalog: readonly Seed[],
  context: BootContext,
  env: Record<string, string>,
): Promise<string[]> {
  const segments: string[] = [];
  for (const ref of refs) {
    if (!ref.enabled) continue;
    const seed = catalog.find((s) => s.name === ref.name);
    if (seed === undefined) {
      throw new Error(`role references unknown seed: ${ref.name}`);
    }
    const text =
      seed.definition.kind === "static"
        ? seed.definition.text
        : await runBootContextProvider(seed.definition.provider, context, env);
    segments.push(text);
  }
  return segments;
}
