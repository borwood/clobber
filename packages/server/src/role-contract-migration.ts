import type { RoleVersion } from "@clobber/shared";
import type {
  MigratedRoleVersion,
  RoleContractMigrationRequest,
  RoleContractMigrator,
} from "./role-contract-compat.ts";

// #238 — the forward-only migration framework behind the #237 seam. When the
// engine contract advances, role versions frozen under an older contract need
// their contract-bearing JSON (a renamed hook event, a reshaped trigger kind,
// …) carried forward before the engine embodies them. The framework is an
// ordered registry of N→N+1 steps; the migrator chains the steps spanning the
// authored version up to the engine version. Forward-only by design (CLAUDE.md):
// there is no path downward.

// A single forward step. It transforms a role version frozen under contract
// `from` into the shape contract `from + 1` expects. The migrator decides which
// step runs by the step's registry slot, never by reading the version's stamp,
// so the step is a pure content transform: it MUST NOT touch `contract_version`.
// That stamp is the authored provenance marker (#236); the chained result is a
// derived value that preserves it.
export interface RoleContractMigrationStep {
  readonly from: number;
  migrate(version: RoleVersion): RoleVersion;
}

// Builds a forward-only migrator from an ordered registry of N→N+1 steps. The
// migrator climbs from the authored version to the engine version one step at a
// time; a missing step at any rung is a gap with no contiguous path, so it
// declines (returns null) and the compat check refuses.
export function createRoleContractMigrator(
  steps: readonly RoleContractMigrationStep[],
): RoleContractMigrator {
  const byFrom = new Map<number, RoleContractMigrationStep>();
  for (const step of steps) {
    if (byFrom.has(step.from)) {
      throw new Error(
        `duplicate role-contract migration step from contract version ${step.from}`,
      );
    }
    byFrom.set(step.from, step);
  }

  return {
    tryMigrate(req: RoleContractMigrationRequest): MigratedRoleVersion | null {
      if (req.fromContractVersion >= req.toContractVersion) return null;

      let current = req.version;
      for (let v = req.fromContractVersion; v < req.toContractVersion; v++) {
        const step = byFrom.get(v);
        if (step === undefined) return null;
        current = step.migrate(current);
      }

      // The migrated version is derived content — the authored stamp rides
      // through untouched (the whole point of #236's provenance marker).
      return { ...current, contract_version: req.version.contract_version };
    },
  };
}

// 1→2: the `habits` field (#408/#409) advanced the engine contract (#432).
// habits are git-tree-only (file-per-habit, #398/#407) and were NEVER flattened
// into a `role_versions` column — `roleSnapshotToContract`, `roleContractToSnapshot`
// and `loadAsBundle` all carry `habits: []`. So the frozen RoleVersion column shape
// is invariant across this bump: a v1-authored row already IS the contract-2 shape.
// The transform is therefore identity — its job is to mark v1 rows forward-carryable
// so the boot sweep MIGRATES them instead of refusing one per adopted version (the
// refusal-flood). The habits delta lives in the materialized RoleTreeContract cache,
// healed there by the version-gate eviction + git re-read, not by this step.
const HABITS_1_TO_2: RoleContractMigrationStep = {
  from: 1,
  migrate: (version) => version,
};

// The production registry — one N→N+1 step per contract advance, in order.
export const ROLE_CONTRACT_MIGRATION_STEPS: readonly RoleContractMigrationStep[] = [
  HABITS_1_TO_2,
];

// The real migrator the spawn pipeline wires in, replacing the empty seam.
export const ROLE_CONTRACT_MIGRATOR: RoleContractMigrator = createRoleContractMigrator(
  ROLE_CONTRACT_MIGRATION_STEPS,
);
