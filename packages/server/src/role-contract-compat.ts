import type { RoleVersion } from "@clobber/shared";

// #237 — the engine acts on the #236 contract stamp. A `RoleVersion` freezes
// contract-bearing JSON (hooks, triggers, tool/cli allowlists, …) authored under
// some engine contract version. Before the engine embodies a pinned version it
// must decide whether that version still means what it meant. This module is the
// single shared decision both boundaries call — a normal spawn (wired here) and
// the engine-adopt sweep (#239, unbuilt). The decision is pure; emitting the
// refusal signal is the caller's concern, so the adopt sweep can batch.

// The cause of a refusal, named so a refusal can be diagnosed (workspace wisdom
// 2026-05-28). Shaped as reusable provenance (rhymes with #221): the row that
// records it carries the role version and both contract versions, not a string.
export interface RoleContractIncompatibility {
  readonly role_name: string;
  readonly role_version_id: string;
  readonly authored_contract_version: number;
  readonly engine_contract_version: number;
}

// A role version migrated forward to the engine's contract. #238 fills in the
// actual transform; v1 has no migrations, so this is only ever the seam's
// return shape, never produced.
export type MigratedRoleVersion = RoleVersion;

export interface RoleContractMigrationRequest {
  readonly version: RoleVersion;
  readonly fromContractVersion: number;
  readonly toContractVersion: number;
}

// The migration seam (#238 will fill it). The check consults it for any stamp
// that does not match the engine's contract version; a migrator returns the
// migrated version or `null` to decline. Injected, not imported, so #238 can
// register migrations without touching the spawn boundary.
export interface RoleContractMigrator {
  tryMigrate(req: RoleContractMigrationRequest): MigratedRoleVersion | null;
}

// v1 ships no migrations: every mismatch declines and falls through to refusal.
export const EMPTY_ROLE_CONTRACT_MIGRATOR: RoleContractMigrator = {
  tryMigrate: () => null,
};

export type RoleContractVerdict =
  | { readonly outcome: "compatible"; readonly version: RoleVersion }
  | { readonly outcome: "migrated"; readonly version: MigratedRoleVersion }
  | { readonly outcome: "incompatible"; readonly cause: RoleContractIncompatibility };

export interface CheckRoleContractCompatInput {
  readonly version: RoleVersion;
  readonly roleName: string;
  // The engine's current contract version, injected (not read from the module
  // constant) so this stays a pure decision the adopt sweep and tests drive with
  // any value.
  readonly engineContractVersion: number;
  readonly migrator: RoleContractMigrator;
}

export function checkRoleContractCompat(
  input: CheckRoleContractCompatInput,
): RoleContractVerdict {
  const authored = input.version.contract_version;
  const engine = input.engineContractVersion;

  if (authored === engine) {
    return { outcome: "compatible", version: input.version };
  }

  const migrated = input.migrator.tryMigrate({
    version: input.version,
    fromContractVersion: authored,
    toContractVersion: engine,
  });
  if (migrated !== null) {
    return { outcome: "migrated", version: migrated };
  }

  return {
    outcome: "incompatible",
    cause: {
      role_name: input.roleName,
      role_version_id: input.version.id,
      authored_contract_version: authored,
      engine_contract_version: engine,
    },
  };
}
