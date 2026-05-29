import { ENGINE_CONTRACT_VERSION, type RoleVersion } from "@clobber/shared";
import { checkRoleContractCompat, type RoleContractMigrator } from "./role-contract-compat.ts";
import type {
  AppendRoleContractRefusalRequest,
  RoleContractRefusalStore,
} from "./role-contract-refusal-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

// #239 — the engine-adopt sweep: the session-less analog of the #237 spawn gate,
// across every role version a workspace has adopted, batched. On boot the engine
// may be running a newer contract than some frozen RoleVersion was authored
// under, so it re-runs the SAME pure decision the spawn gate calls
// (`checkRoleContractCompat`) over the lot. Incompatible versions are
// quarantined-with-signal — a refusal row, never a throw — so an unmigratable
// version surfaces for the operator without wedging boot. This is the
// recheck-at-boot half of the ritual only; draining and re-embodying live
// sessions is deferred (the "shipped ≠ running" gap, #197).

// One unit of work: a frozen version, the workspace that adopted it, and the
// role it belongs to. The refusal store is workspace-keyed, so the workspace is
// carried per candidate — a global role adopted by N workspaces yields N
// candidates, one refusal per workspace.
export interface RoleContractSweepCandidate {
  readonly workspaceId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly version: RoleVersion;
}

export interface SweepRoleContractsInput {
  readonly candidates: readonly RoleContractSweepCandidate[];
  // Injected (not read from the module constant) so the decision stays pure and
  // a test can drive it with any engine version — the migrated branch is only
  // reachable when the engine is ahead of the authored stamp.
  readonly engineContractVersion: number;
  readonly migrator: RoleContractMigrator;
}

// Pure: runs the shared compat check over every candidate and returns a refusal
// request for each incompatible one — the caller emits (appends), exactly as
// the spawn gate keeps `checkRoleContractCompat` pure and emits the signal
// itself. Compatible and migrated verdicts produce nothing; v1 does NOT persist
// migrated versions back to the store (deferred until a real migration exists).
export function sweepRoleContracts(
  input: SweepRoleContractsInput,
): AppendRoleContractRefusalRequest[] {
  const refusals: AppendRoleContractRefusalRequest[] = [];
  for (const candidate of input.candidates) {
    const verdict = checkRoleContractCompat({
      version: candidate.version,
      roleName: candidate.roleName,
      engineContractVersion: input.engineContractVersion,
      migrator: input.migrator,
    });
    if (verdict.outcome !== "incompatible") continue;
    // Absent agent_id is the adopt boundary — no session exists yet (#237 store
    // header). workspace_id + role_id pin the refusal to what was adopted.
    refusals.push({
      workspace_id: candidate.workspaceId,
      role_id: candidate.roleId,
      cause: verdict.cause,
    });
  }
  return refusals;
}

export interface BootRoleContractSweepDeps {
  readonly workspaces: WorkspaceStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly roleContractRefusals: RoleContractRefusalStore;
  readonly migrator: RoleContractMigrator;
}

// The boot caller. Enumerates every (workspace, adopted role, version) tuple
// from the existing stores — refusals are workspace-keyed, and a role attaches
// to a workspace through the ceiling table, not a version→workspace link, so a
// flat `listAllVersions()` would have no workspace to name. Then runs the pure
// sweep with the engine's current contract version + the SHARED migrator (the
// same instance the spawn pipeline wires in — one migrator, both boundaries),
// and appends each refusal.
export function runBootRoleContractSweep(deps: BootRoleContractSweepDeps): void {
  const candidates: RoleContractSweepCandidate[] = [];
  for (const workspace of deps.workspaces.list()) {
    for (const assignment of deps.workspaceRoles.listForWorkspace(workspace.id)) {
      const { role } = assignment;
      for (const summary of deps.roleVersions.listForRole(role.id)) {
        const version = deps.roleVersions.get(summary.id);
        if (version === null) {
          throw new Error(
            `role version ${summary.id} was listed for role ${role.id} but could not be loaded`,
          );
        }
        candidates.push({
          workspaceId: workspace.id,
          roleId: role.id,
          roleName: role.name,
          version,
        });
      }
    }
  }

  const refusals = sweepRoleContracts({
    candidates,
    engineContractVersion: ENGINE_CONTRACT_VERSION,
    migrator: deps.migrator,
  });
  for (const refusal of refusals) {
    deps.roleContractRefusals.append(refusal);
  }
}
