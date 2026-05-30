import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { ensureUpstreamRoleRepo, type ForkRef } from "./role-repo.ts";
import { createRoleContentCache, type RoleContentCache } from "./role-content-cache.ts";
import {
  createWorkspaceRoleRepos,
  type WorkspaceRoleRepos,
} from "./workspace-role-repos.ts";

// #349 git-as-truth — boot wiring for the commit-pinned read path. The spawn
// pipeline and whiteboard spread this in, so both embody commit-backed roles the
// same way. An absent `roleRepoDir` means git-as-truth is not configured (tests
// that exercise only the row-backed store), and embodiment stays on the
// `role_versions` path.
//
// #385 — `roleForks` (role name → its fork tip) is the materialized map seeding
// pins a fresh workspace's roles to. It is present exactly when `roleRepoDir` is,
// so its presence is the same git-as-truth gate the read path uses.
export interface RoleEmbodimentConfig {
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  readonly roleForks?: ReadonlyMap<string, ForkRef>;
  // #351 topology B — per-workspace clones of the upstream. A migrated workspace
  // role's commit lives ONLY in its clone, so embodiment resolves its repo dir
  // from here (a null-workspace role stays on the upstream `roleRepoDir`).
  readonly workspaceRepos?: WorkspaceRoleRepos;
}

export function configureRoleEmbodiment(
  db: Database,
  roleRepoDir: string | undefined,
): RoleEmbodimentConfig {
  if (roleRepoDir === undefined) return {};
  // Materialize the upstream repo into the data dir once; re-opens on later boots.
  const upstream = ensureUpstreamRoleRepo(roleRepoDir);
  const reposBaseDir = join(dirname(roleRepoDir), "role-repos");
  return {
    roleRepoDir,
    roleContentCache: createRoleContentCache(db),
    roleForks: upstream.forks,
    workspaceRepos: createWorkspaceRoleRepos({ upstreamDir: roleRepoDir, reposBaseDir }),
  };
}
