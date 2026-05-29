import type { Database } from "bun:sqlite";
import { runBootRoleContractSweep } from "./role-contract-sweep.ts";
import {
  configureRoleEmbodiment,
  type RoleEmbodimentConfig,
} from "./role-embodiment-config.ts";
import type { RoleContractMigrator } from "./role-contract-compat.ts";
import type { RoleContractRefusalStore } from "./role-contract-refusal-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

export interface BootServerRolesInput {
  readonly db: Database;
  readonly roleRepoDir: string | undefined;
  readonly workspaces: WorkspaceStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly roleContractRefusals: RoleContractRefusalStore;
  readonly migrator: RoleContractMigrator;
}

// The role wiring the server runs once at boot, before routes, so the audit is
// current at go-live and embodiment is ready:
//  - #239 engine-adopt sweep: re-check every adopted role version against the
//    engine's contract through the SHARED migrator; incompatible → quarantined as
//    a refusal row, never a throw (boot is never wedged).
//  - #349 git-as-truth: materialize the upstream role repo + build the sha-keyed
//    content cache, returned for the spawn pipeline + whiteboard to spread in.
export function bootServerRoles(input: BootServerRolesInput): RoleEmbodimentConfig {
  runBootRoleContractSweep({
    workspaces: input.workspaces,
    workspaceRoles: input.workspaceRoles,
    roleVersions: input.roleVersions,
    roleContractRefusals: input.roleContractRefusals,
    migrator: input.migrator,
  });
  return configureRoleEmbodiment(input.db, input.roleRepoDir);
}
