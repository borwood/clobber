import type { Database } from "bun:sqlite";
import {
  configureRoleEmbodiment,
  type RoleEmbodimentConfig,
} from "./role-embodiment-config.ts";

export interface BootServerRolesInput {
  readonly db: Database;
  readonly roleRepoDir: string | undefined;
}

// Boot-time role wiring (before routes): #349 git-as-truth — materialize the
// upstream role repo + build the sha-keyed content cache, returned for the spawn
// pipeline + whiteboard to spread in. The #239/#237 contract sweep/gate are
// removed (#491): all roles are commit-pinned and current by construction.
export function bootServerRoles(input: BootServerRolesInput): RoleEmbodimentConfig {
  return configureRoleEmbodiment(input.db, input.roleRepoDir);
}
