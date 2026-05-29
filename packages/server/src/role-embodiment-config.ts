import type { Database } from "bun:sqlite";
import { ensureUpstreamRoleRepo } from "./role-repo.ts";
import { createRoleContentCache, type RoleContentCache } from "./role-content-cache.ts";

// #349 git-as-truth — boot wiring for the commit-pinned read path. The spawn
// pipeline and whiteboard spread this in, so both embody commit-backed roles the
// same way. An absent `roleRepoDir` means git-as-truth is not configured (tests
// that exercise only the row-backed store), and embodiment stays on the
// `role_versions` path.
export interface RoleEmbodimentConfig {
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
}

export function configureRoleEmbodiment(
  db: Database,
  roleRepoDir: string | undefined,
): RoleEmbodimentConfig {
  if (roleRepoDir === undefined) return {};
  // Materialize the upstream repo into the data dir once; re-opens on later boots.
  ensureUpstreamRoleRepo(roleRepoDir);
  return { roleRepoDir, roleContentCache: createRoleContentCache(db) };
}
