import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SeedDefinitionSchema, type Seed } from "@clobber/shared";
import { enumerateDefaultSeeds } from "@clobber/runtime";

// The workspace seed catalog = the shipped default seeds overlaid by the
// filesystem catalog at <repo>/.clobber/seeds/<name>/seed.json. A filesystem
// entry shadows a default of the same name. Mirrors loadWorkspaceSkillCatalog
// (#136): re-read on every spawn (stateless), so a workspace editing seeds in
// its repo sees the change on the next spawn. The filesystem layer is the seam
// the #214 authoring CLI writes into — a manager-authored seed is an ordinary
// catalog entry, no privilege difference from a default.
const CATALOG_SUBDIR = ".clobber/seeds";
const SEED_FILE = "seed.json";

export function resolveSeedCatalog(repoPath: string): Seed[] {
  const byName = new Map<string, Seed>();
  for (const seed of enumerateDefaultSeeds()) {
    byName.set(seed.name, seed);
  }

  const dir = join(repoPath, CATALOG_SUBDIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const seedPath = join(dir, entry.name, SEED_FILE);
      if (!existsSync(seedPath)) continue;
      const definition = SeedDefinitionSchema.parse(
        JSON.parse(readFileSync(seedPath, "utf8")),
      );
      byName.set(entry.name, { name: entry.name, definition });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
