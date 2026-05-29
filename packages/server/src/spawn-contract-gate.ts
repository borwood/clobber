import { ENGINE_CONTRACT_VERSION, type Agent, type Role, type Workspace } from "@clobber/shared";
import { checkRoleContractCompat } from "./role-contract-compat.ts";
import type { RolePin } from "./embody-role.ts";
import type { SpawnPipelineDeps, SpawnPipelineRoleContractError } from "./spawn-pipeline.ts";

export interface GateRoleContractInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  // The pin about to be embodied. Null (no current version) falls through to
  // prepareSpawnContext's no-bundle refusal. A commit pin (#349) is git-backed
  // and current by construction, so only a `version` pin reaches the compat check.
  readonly pin: RolePin | null;
}

// #237 — the contract gate on the fresh-attach (spawn) boundary. Reads the
// pinned version's contract stamp and consults the shared compat decision +
// injected migration seam. A compatible (or migrated) version returns `null`
// (proceed); an unmigratable mismatch is refused-with-signal and the refusal is
// returned. Resume is intentionally not gated here — a live session is already
// trusted and re-composes through prepareSpawnContext directly.
export function gateRoleContract(
  deps: SpawnPipelineDeps,
  input: GateRoleContractInput,
): SpawnPipelineRoleContractError | null {
  const { workspace, role, agent, pin } = input;
  if (pin === null || pin.kind !== "version") return null;
  const version = deps.roleVersions.get(pin.versionId);
  if (version === null) return null;

  const verdict = checkRoleContractCompat({
    version,
    roleName: role.name,
    engineContractVersion: ENGINE_CONTRACT_VERSION,
    migrator: deps.roleContractMigrator,
  });
  if (verdict.outcome !== "incompatible") return null;

  // Refuse-with-signal (never swallow). Record the cause in the durable,
  // session-independent refusal audit the manager triages, and return it to the
  // caller (the manager, when it spawns). Nothing is spawned.
  const { cause } = verdict;
  deps.roleContractRefusals.append({
    workspace_id: workspace.id,
    agent_id: agent.id,
    role_id: role.id,
    cause,
  });

  return {
    ok: false,
    status: 409,
    error: "role-contract-incompatible",
    role: cause.role_name,
    role_version_id: cause.role_version_id,
    authored_contract_version: cause.authored_contract_version,
    engine_contract_version: cause.engine_contract_version,
  };
}
