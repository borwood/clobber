import type { BootContext, PromptModule, PromptModuleRef } from "@clobber/shared";
import { runBootContextProvider } from "./boot-context-provider.ts";

// Resolves a role's ordered, toggleable prompt-module references against the
// workspace catalog and composes each into a layer-B segment, in ref order. A
// static module contributes its stored text; a dynamic module contributes its
// provider's stdout run with the spawn env present. Disabled refs drop out. An
// enabled ref to a module absent from the catalog is unexpected data → throw
// (no defensive skip).
export async function composePromptModules(
  refs: readonly PromptModuleRef[],
  catalog: readonly PromptModule[],
  context: BootContext,
  env: Record<string, string>,
): Promise<string[]> {
  const segments: string[] = [];
  for (const ref of refs) {
    if (!ref.enabled) continue;
    const mod = catalog.find((m) => m.name === ref.name);
    if (mod === undefined) {
      throw new Error(`role references unknown prompt-module: ${ref.name}`);
    }
    const text =
      mod.definition.kind === "static"
        ? mod.definition.text
        : await runBootContextProvider(mod.definition.provider, context, env);
    segments.push(text);
  }
  return segments;
}
