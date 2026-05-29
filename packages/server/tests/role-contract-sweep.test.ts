import { describe, expect, it } from "bun:test";
import type { RoleVersion } from "@clobber/shared";
import {
  createRoleContractMigrator,
  type RoleContractMigrationStep,
} from "../src/role-contract-migration.ts";
import { EMPTY_ROLE_CONTRACT_MIGRATOR } from "../src/role-contract-compat.ts";
import {
  sweepRoleContracts,
  type RoleContractSweepCandidate,
} from "../src/role-contract-sweep.ts";

// #239 — the pure batched decision behind the boot sweep. It mirrors the #237
// gate (pure check, caller emits) but over a list. Driven here with a synthetic
// `engineContractVersion` so the migrated path is reachable: at the real boot
// engine version (v1) an authored stamp is always >= 1 = engine, so a version
// can only ever be compatible or refused — the migrated branch needs an engine
// ahead of the authored stamp, exactly as role-contract-migration.test.ts does.

function versionStampedAt(id: string, contractVersion: number): RoleVersion {
  return {
    id,
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

function candidate(version: RoleVersion): RoleContractSweepCandidate {
  return {
    workspaceId: "ws-1",
    roleId: version.role_id,
    roleName: "worker",
    version,
  };
}

const markStep = (from: number): RoleContractMigrationStep => ({
  from,
  migrate: (v) => v,
});

describe("sweepRoleContracts (#239) — pure batched compat decision", () => {
  it("yields a refusal request only for incompatible candidates", () => {
    const compatible = candidate(versionStampedAt("v-ok", 1));
    const incompatible = candidate(versionStampedAt("v-bad", 2));

    const refusals = sweepRoleContracts({
      candidates: [compatible, incompatible],
      engineContractVersion: 1,
      migrator: EMPTY_ROLE_CONTRACT_MIGRATOR,
    });

    expect(refusals).toHaveLength(1);
    const refusal = refusals[0]!;
    expect(refusal.workspace_id).toBe("ws-1");
    expect(refusal.role_id).toBe(incompatible.version.role_id);
    expect(refusal.cause.role_version_id).toBe("v-bad");
    expect(refusal.cause.authored_contract_version).toBe(2);
    expect(refusal.cause.engine_contract_version).toBe(1);
    // The adopt boundary attaches no agent.
    expect("agent_id" in refusal).toBe(false);
  });

  it("a migratable candidate is migrated, not refused (v1 does not persist it)", () => {
    // Engine ahead of the authored stamp + a contiguous step → migrated.
    const migrator = createRoleContractMigrator([markStep(1)]);
    const migratable = candidate(versionStampedAt("v-mig", 1));

    const refusals = sweepRoleContracts({
      candidates: [migratable],
      engineContractVersion: 2,
      migrator,
    });

    // Migrated → nothing recorded (no migrated-row persistence at v1).
    expect(refusals).toHaveLength(0);
  });

  it("a mismatch with no contiguous migration path is refused", () => {
    // 1→2 registered, engine at 3 → gap → declines → incompatible.
    const migrator = createRoleContractMigrator([markStep(1)]);
    const refusals = sweepRoleContracts({
      candidates: [candidate(versionStampedAt("v-gap", 1))],
      engineContractVersion: 3,
      migrator,
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.cause.role_version_id).toBe("v-gap");
  });

  it("an empty candidate list yields no refusals", () => {
    const refusals = sweepRoleContracts({
      candidates: [],
      engineContractVersion: 1,
      migrator: EMPTY_ROLE_CONTRACT_MIGRATOR,
    });
    expect(refusals).toHaveLength(0);
  });
});
