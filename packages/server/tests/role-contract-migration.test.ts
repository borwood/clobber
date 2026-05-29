import { describe, expect, it } from "bun:test";
import type { RoleVersion } from "@clobber/shared";
import { checkRoleContractCompat } from "../src/role-contract-compat.ts";
import {
  createRoleContractMigrator,
  ROLE_CONTRACT_MIGRATOR,
  type RoleContractMigrationStep,
} from "../src/role-contract-migration.ts";

// #238 — the forward-only migration framework that fills the #237 seam. These
// drive the framework THROUGH the real compat decision (the integration that
// matters): a version stamped under an older contract, an engine at a newer
// one, and a registry of synthetic N→N+1 steps. `engineContractVersion` is
// injected into checkRoleContractCompat (it does not read the module constant),
// so the test can author a v1 stamp and pretend the engine has advanced —
// without an actual contract bump, of which there are none yet.

function versionStampedAt(contractVersion: number): RoleVersion {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    role_id: "00000000-0000-0000-0000-000000000002",
    version: 1,
    framing: "",
    system_prompt: "authored",
    skills_json: "[]",
    allowed_tools_json: "[]",
    allowed_cli_commands_json: "[]",
    hooks_json: "{}",
    triggers_json: "[]",
    seed_refs_json: "[]",
    wake_programs_json: "[]",
    default_wake_program: null,
    contract_version: contractVersion,
    created_at: 0,
  };
}

// A synthetic step rewrites a frozen contract field (here system_prompt) with a
// marker, so the chain's presence and ORDER are observable in the output.
function markStep(from: number, marker: string): RoleContractMigrationStep {
  return {
    from,
    migrate: (v) => ({ ...v, system_prompt: `${v.system_prompt}${marker}` }),
  };
}

describe("forward-only role-contract migration framework (#238)", () => {
  it("chains a registered step authored→engine and returns the migrated version", () => {
    const migrator = createRoleContractMigrator([markStep(1, "::s12")]);

    const verdict = checkRoleContractCompat({
      version: versionStampedAt(1),
      roleName: "worker",
      engineContractVersion: 2,
      migrator,
    });

    if (verdict.outcome !== "migrated") {
      throw new Error(`expected a migrated verdict, got ${verdict.outcome}`);
    }
    expect(verdict.version.system_prompt).toBe("authored::s12");
  });

  it("chains multiple steps in order across more than one contract bump", () => {
    const migrator = createRoleContractMigrator([
      markStep(1, "::s12"),
      markStep(2, "::s23"),
    ]);

    const verdict = checkRoleContractCompat({
      version: versionStampedAt(1),
      roleName: "worker",
      engineContractVersion: 3,
      migrator,
    });

    if (verdict.outcome !== "migrated") {
      throw new Error(`expected a migrated verdict, got ${verdict.outcome}`);
    }
    // Order proves the chain ran 1→2 then 2→3, not the reverse.
    expect(verdict.version.system_prompt).toBe("authored::s12::s23");
  });

  it("preserves the authored contract_version stamp — the migrated version is derived", () => {
    const migrator = createRoleContractMigrator([
      markStep(1, "::s12"),
      markStep(2, "::s23"),
    ]);

    const verdict = checkRoleContractCompat({
      version: versionStampedAt(1),
      roleName: "worker",
      engineContractVersion: 3,
      migrator,
    });

    if (verdict.outcome !== "migrated") {
      throw new Error(`expected a migrated verdict, got ${verdict.outcome}`);
    }
    // The stamp is the immutable provenance marker (#236) — migration rewrites
    // content but must NOT re-stamp it to the engine version.
    expect(verdict.version.contract_version).toBe(1);
  });

  it("declines (→ incompatible) when no contiguous path of steps spans the gap", () => {
    // 1→2 is registered but 2→3 is missing; the engine is at 3, so the chain
    // hits a gap and the migrator returns null → the compat check refuses.
    const migrator = createRoleContractMigrator([markStep(1, "::s12")]);

    const verdict = checkRoleContractCompat({
      version: versionStampedAt(1),
      roleName: "worker",
      engineContractVersion: 3,
      migrator,
    });

    expect(verdict.outcome).toBe("incompatible");
  });

  it("ships zero real steps — every mismatch declines through the production registry", () => {
    const verdict = checkRoleContractCompat({
      version: versionStampedAt(1),
      roleName: "worker",
      engineContractVersion: 2,
      migrator: ROLE_CONTRACT_MIGRATOR,
    });

    expect(verdict.outcome).toBe("incompatible");
  });
});
