import type { Agent, Role, Workspace } from "@clobber/shared";
import type { RolePin } from "./embody-role.ts";
import type { SpawnPipelineNoBundleError } from "./spawn-pipeline.ts";

export interface GateRoleContractInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly pin: RolePin | null;
}

// #491 — the version-pinned contract gate is removed. All roles are commit-pinned
// (#349) and commit content is current by construction. This stub is kept so any
// remaining callers compile; it always returns null (proceed).
export function gateRoleContract(
  _deps: unknown,
  _input: GateRoleContractInput,
): SpawnPipelineNoBundleError | null {
  return null;
}
