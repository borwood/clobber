import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PromptModuleDefinitionSchema, type PromptModule } from "@clobber/shared";
import { enumerateDefaultPromptModules } from "@clobber/runtime";

// Source of a resolved catalog entry. Used by the authoring routes to surface
// where a module came from and whether an edit would shadow a default.
export type PromptModuleSource = "shipped-default" | "workspace" | "shadows-default";

export interface PromptModuleWithSource extends PromptModule {
  readonly source: PromptModuleSource;
}

// Like resolvePromptModuleCatalog but annotates each entry with its source.
// Co-located here so both consumers share the same FS read logic.
export function resolvePromptModuleCatalogWithSources(
  repoPath: string,
): PromptModuleWithSource[] {
  const defaultNames = new Set(enumerateDefaultPromptModules().map((m) => m.name));

  const workspaceNames = new Set<string>();
  const dir = join(repoPath, CATALOG_SUBDIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(dir, entry.name, MODULE_FILE))) {
        workspaceNames.add(entry.name);
      }
    }
  }

  const resolved = resolvePromptModuleCatalog(repoPath);
  return resolved.map((mod) => {
    const inWorkspace = workspaceNames.has(mod.name);
    const inDefaults = defaultNames.has(mod.name);
    const source: PromptModuleSource =
      inWorkspace && inDefaults
        ? "shadows-default"
        : inWorkspace
          ? "workspace"
          : "shipped-default";
    return { ...mod, source };
  });
}

// The workspace prompt-module catalog = the shipped defaults overlaid by the
// filesystem catalog at <repo>/.clobber/prompt-modules/<name>/prompt-module.json.
// A filesystem entry shadows a default of the same name. Mirrors
// loadWorkspaceSkillCatalog (#136): re-read on every spawn (stateless), so a
// workspace editing modules in its repo sees the change on the next spawn. The
// filesystem layer is the seam the #214 authoring CLI writes into — a
// manager-authored module is an ordinary catalog entry, no privilege difference
// from a default.
//
// Tolerant resolver: the new .clobber/prompt-modules/ catalog is checked first;
// if an entry is absent there the legacy .clobber/seeds/<name>/seed.json path is
// tried as a fallback so existing forks with authored modules still resolve.
const CATALOG_SUBDIR = ".clobber/prompt-modules";
const MODULE_FILE = "prompt-module.json";
const LEGACY_CATALOG_SUBDIR = ".clobber/seeds";
const LEGACY_MODULE_FILE = "seed.json";

export function resolvePromptModuleCatalog(repoPath: string): PromptModule[] {
  const byName = new Map<string, PromptModule>();
  for (const mod of enumerateDefaultPromptModules()) {
    byName.set(mod.name, mod);
  }

  const dir = join(repoPath, CATALOG_SUBDIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modulePath = join(dir, entry.name, MODULE_FILE);
      if (!existsSync(modulePath)) continue;
      const definition = PromptModuleDefinitionSchema.parse(
        JSON.parse(readFileSync(modulePath, "utf8")),
      );
      byName.set(entry.name, { name: entry.name, definition });
    }
  }

  // Tolerant fallback: read legacy .clobber/seeds/ entries not already resolved
  // from the new catalog dir. This lets existing forks with authored modules
  // continue to work without a migration step.
  const legacyDir = join(repoPath, LEGACY_CATALOG_SUBDIR);
  if (existsSync(legacyDir)) {
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (byName.has(entry.name)) continue;
      const legacyPath = join(legacyDir, entry.name, LEGACY_MODULE_FILE);
      if (!existsSync(legacyPath)) continue;
      const definition = PromptModuleDefinitionSchema.parse(
        JSON.parse(readFileSync(legacyPath, "utf8")),
      );
      byName.set(entry.name, { name: entry.name, definition });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
