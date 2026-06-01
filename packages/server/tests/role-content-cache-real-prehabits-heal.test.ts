import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { compileSelfHabits } from "@clobber/runtime";
import { createDatabase } from "../src/db.ts";
import { createRoleContentCache } from "../src/role-content-cache.ts";
import { ensureUpstreamRoleRepo } from "../src/role-repo.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createRoleContractRefusalStore } from "../src/role-contract-refusal-store.ts";
import { runBootRoleContractSweep, sweepRoleContracts } from "../src/role-contract-sweep.ts";
import type { RoleContractSweepCandidate } from "../src/role-contract-sweep.ts";
import { ROLE_CONTRACT_MIGRATOR } from "../src/role-contract-migration.ts";

// #432 — heal the INERT #430 cache gate. #430 shipped the gate but never bumped
// ENGINE_CONTRACT_VERSION when `habits` landed, so a pre-habits cache row stamped
// at the REAL prior contract (1) passed the gate (`1 < 1` false), re-hydrated with
// `habits` undefined, and crashed resume at `compileSelfHabits(undefined,…)`.
//
// The existing version-gate test seeds a SYNTHETIC `ENGINE_CONTRACT_VERSION - 1`
// row — it tracks the constant and stays green even while the real bug ships.
// These tests present the REAL pre-habits shape against a POPULATED, pre-existing
// DB: many `role_versions` rows frozen at contract 1, plus a cache row whose JSON
// has no `habits` KEY at all. They fail for the real reason until the version is
// bumped and the first 1→2 migration step is registered.
//
// FIDELITY NOTE: the populated DB is built programmatically, not restored from a
// `clobber.db*.bak` backup. A committed backup slice is disallowed — it carries
// sunset role-name tokens the #144 vocabulary invariant forbids, plus local-path
// data. It is also unnecessary: `habits` was NEVER flattened into a `role_versions`
// column (roleSnapshotToContract / roleContractToSnapshot / loadAsBundle all carry
// `habits: []`), so a row stamped at contract 1 IS byte-for-byte the real
// pre-habits shape — the row schema is invariant across this bump. The real .bak
// was used during research to confirm ~96 surviving v1 candidates flood with no
// 1→2 step and zero with it.

const HOOK_URL = "http://localhost:3000/hooks/x";
// Non-shipped role names on purpose: the shipped roles (worker, manager) are
// re-snapshotted to the current contract by boot migrations, so the rows that
// persist as contract-1 are the forked/custom/no-longer-shipped ones — exactly the
// population the real post-cutover `.bak` retains as v1.
const SEEDED_ROLES = ["archivist", "sentry", "courier", "warden"] as const;

// Populate a DB: a workspace adopting several roles, each with a role-version row
// frozen at contract 1 — the real pre-habits stamp. The version JSON is the
// minimal valid shape; the sweep's compat decision reads only the stamp + id, and
// `habits` was never a version column, so a contract-1 row IS the pre-habits shape.
// Returns the role count seeded.
function seedPreHabitsRoles(db: ReturnType<typeof createDatabase>): number {
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const ws = workspaces.create({ name: "ws", repo_path: "/tmp/x" });
  const workspaceRoles = createWorkspaceRoleStore(db);
  // contract_version defaults to 1 in the schema — the historical pre-habits stamp.
  const insertVersion = db.prepare(
    `INSERT INTO role_versions
       (id, role_id, version, framing, system_prompt, skills_json, allowed_tools_json, hooks_json, created_at)
     VALUES (?, ?, 1, 'framing', 'prompt', '[]', '[]', '{}', ?)`,
  );
  for (const name of SEEDED_ROLES) {
    const role = roles.create({ name, persistent: false });
    workspaceRoles.setCeiling(ws.id, role.id, 1);
    insertVersion.run(randomUUID(), role.id, Date.now());
  }
  return SEEDED_ROLES.length;
}

describe("#432 real pre-habits heal against a populated pre-existing DB", () => {
  let roleRepoDir: string;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "clobber-prehabits-"));
    roleRepoDir = join(tmpRoot, "role-repo");
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("a real pre-habits cache row (habits absent, stamped contract 1) is evicted and re-materialized with habits:[] — resume no longer crashes", () => {
    const db = createDatabase(":memory:");
    seedPreHabitsRoles(db);
    const repoHandle = ensureUpstreamRoleRepo(roleRepoDir);
    const sha = repoHandle.forks.get("worker")!.sha;

    // The REAL prior shape: the `habits` KEY is absent from the JSON (not merely a
    // decremented version stamp), stamped at contract_version 1 — the literal
    // version pre-habits rows actually carry, NOT `ENGINE_CONTRACT_VERSION - 1`,
    // which would track the bump and mask a future regression.
    const preHabitsJson = JSON.stringify({
      framing: "",
      systemPrompt: "",
      skills: [],
      allowedTools: [],
      allowedCliCommands: [],
      hooks: "{}",
      triggers: [],
      seedRefs: [],
      wakePrograms: [],
      defaultWakeProgram: null,
      // `habits` intentionally absent — the field that shipped after this row.
    });
    db.prepare(
      "INSERT INTO materialized_role_cache (sha, contract_json, contract_version, created_at) VALUES (?, ?, 1, ?)",
    ).run(sha, preHabitsJson, Date.now());

    // The crash this heals: a row served as-is yields `habits: undefined`, and
    // compileSelfHabits iterates it → throws. This is the resume 500.
    const staleHabits = (JSON.parse(preHabitsJson) as { habits?: never }).habits;
    expect(staleHabits).toBeUndefined();
    expect(() => compileSelfHabits(staleHabits as never, HOOK_URL)).toThrow();

    const cache = createRoleContentCache(db);

    // After the bump (engine 2 > row's 1) the gate fires: the stale row is a miss.
    expect(cache.get(sha)).toBeNull();

    // getOrLoad reloads fresh from the git tree through deserializeRoleTree, which
    // normalizes habits to an array, and re-stamps the current contract version.
    const healed = cache.getOrLoad(sha, roleRepoDir);
    expect(Array.isArray(healed.contract.habits)).toBe(true);
    expect(healed.contractVersion).toBe(ENGINE_CONTRACT_VERSION);

    // End-to-end: the re-materialized habits feed compileSelfHabits without the
    // crash — resume is healed.
    expect(() => compileSelfHabits(healed.contract.habits, HOOK_URL)).not.toThrow();

    // The re-cached row carries the current version, so the next read is a hit.
    const reRead = db
      .prepare("SELECT contract_version FROM materialized_role_cache WHERE sha = ?")
      .get(sha) as { contract_version: number };
    expect(reRead.contract_version).toBe(ENGINE_CONTRACT_VERSION);

    db.close();
  });

  it("legacy contract-1 role_versions are MIGRATED (not refused) by the boot sweep on a populated DB", () => {
    const db = createDatabase(":memory:");
    const seeded = seedPreHabitsRoles(db);
    const deps = {
      workspaces: createWorkspaceStore(db),
      workspaceRoles: createWorkspaceRoleStore(db),
      roleVersions: createRoleVersionStore(db),
      roleContractRefusals: createRoleContractRefusalStore(db),
      migrator: ROLE_CONTRACT_MIGRATOR,
    };

    // Mirror the boot caller's enumeration and assert a POPULATED, all-v1 candidate
    // set — so this can never silently pass on a DB that lost its pre-habits rows.
    const candidates: RoleContractSweepCandidate[] = [];
    for (const w of deps.workspaces.list()) {
      for (const assignment of deps.workspaceRoles.listForWorkspace(w.id)) {
        for (const summary of deps.roleVersions.listForRole(assignment.role.id)) {
          candidates.push({
            workspaceId: w.id,
            roleId: assignment.role.id,
            roleName: assignment.role.name,
            version: deps.roleVersions.get(summary.id)!,
          });
        }
      }
    }
    expect(candidates.length).toBe(seeded);
    expect(candidates.every((c) => c.version.contract_version === 1)).toBe(true);

    // The core TDD assertion, independent of the engine constant: run the SHARED
    // production migrator against an engine one contract ahead. Without the 1→2
    // step every v1 candidate refuses (the flood #432 prevents); with it, every
    // one migrates forward — zero refusals.
    const refusalsAtEngine2 = sweepRoleContracts({
      candidates,
      engineContractVersion: 2,
      migrator: ROLE_CONTRACT_MIGRATOR,
    });
    expect(refusalsAtEngine2.length).toBe(0);

    // And the end-to-end boot caller (reading the real ENGINE_CONTRACT_VERSION)
    // appends no refusals — a clean post-bump boot, not a refusal-flood.
    runBootRoleContractSweep(deps);
    const persistedRefusals = deps.workspaces
      .list()
      .flatMap((w) => deps.roleContractRefusals.listForWorkspace(w.id)).length;
    expect(persistedRefusals).toBe(0);

    db.close();
  });
});
