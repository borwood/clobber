import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";

// Regression: createDatabase must add the contract_version column
// (migrateRoleContractVersion) BEFORE migrateRoleVersions runs. migrateRoleVersions
// constructs a RoleVersionStore whose prepared INSERT references contract_version
// (role-version-store.ts), so on an EXISTING database predating #236 — where
// role_versions has no such column — constructing that store throws at prepare time
// and boot crashes. Fresh databases never caught this: SCHEMA declares the column up
// front, so every store prepare succeeded and the whole suite stayed green while real
// installs crashed on upgrade. This drives the full createDatabase sequence against a
// pre-#236 shape so the ordering is enforced by a test, not by luck.
describe("createDatabase migration ordering (existing-DB upgrade)", () => {
  it("upgrades a pre-#236 database (role_versions lacking contract_version) without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-mig-order-"));
    const path = join(dir, "existing.db");
    try {
      // Build a full current-schema DB with a real role + version, then strip the
      // contract_version column to simulate a database created before #236.
      const seed = createDatabase(path);
      const role = createRoleStore(seed).create({ name: "manager", persistent: true });
      const versionId = role.current_version_id;
      if (versionId === undefined) throw new Error("seeded role has no current_version_id");
      seed.exec("ALTER TABLE role_versions DROP COLUMN contract_version");
      seed.close();

      // Reopen: re-runs the migration sequence against the now-existing DB. Buggy
      // order throws inside migrateRoleVersions; fixed order re-adds + backfills.
      const db = createDatabase(path);
      const cols = (
        db.prepare("PRAGMA table_info(role_versions)").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(cols).toContain("contract_version");
      const stamp = db
        .prepare("SELECT contract_version AS c FROM role_versions WHERE id = ?")
        .get(versionId) as { c: number };
      expect(stamp.c).toBe(ENGINE_CONTRACT_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
