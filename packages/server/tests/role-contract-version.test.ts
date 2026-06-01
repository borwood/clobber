import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { migrateRoleContractVersion } from "../src/role-contract-version-migration.ts";

function tableColumns(db: Database, table: string): readonly string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

describe("ENGINE_CONTRACT_VERSION (#236)", () => {
  it("is a positive monotonic integer starting at or above 1", () => {
    expect(Number.isInteger(ENGINE_CONTRACT_VERSION)).toBe(true);
    expect(ENGINE_CONTRACT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("role_versions.contract_version stamp (#236)", () => {
  it("declares the contract_version column on a fresh database", () => {
    const db = createDatabase(":memory:");
    expect(tableColumns(db, "role_versions")).toContain("contract_version");
    db.close();
  });

  it("stamps a freshly authored role version with the current engine contract version", () => {
    const db = createDatabase(":memory:");
    const roles = createRoleStore(db);
    const versions = createRoleVersionStore(db);

    const role = roles.create({ name: "manager", persistent: true });
    const v1 = versions.get(role.current_version_id!)!;

    expect(v1.contract_version).toBe(ENGINE_CONTRACT_VERSION);
    db.close();
  });
});

describe("migrateRoleContractVersion (#236)", () => {
  // A pre-#236 role_versions table — no contract_version column. Proves the
  // additive migration adds the column and backfills existing rows to the
  // contract version current when the column was introduced.
  function legacyDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE role_versions (
        id                        TEXT    PRIMARY KEY,
        role_id                   TEXT    NOT NULL,
        version                   INTEGER NOT NULL,
        framing                   TEXT    NOT NULL DEFAULT '',
        system_prompt             TEXT    NOT NULL,
        skills_json               TEXT    NOT NULL,
        allowed_tools_json        TEXT    NOT NULL,
        allowed_cli_commands_json TEXT    NOT NULL DEFAULT '[]',
        hooks_json                TEXT    NOT NULL,
        triggers_json             TEXT    NOT NULL DEFAULT '[]',
        seed_refs_json            TEXT    NOT NULL DEFAULT '[]',
        wake_programs_json        TEXT    NOT NULL DEFAULT '[]',
        default_wake_program      TEXT,
        created_at                INTEGER NOT NULL
      );
    `);
    return db;
  }

  it("adds the column and backfills existing rows to the frozen historical contract version 1", () => {
    const db = legacyDb();
    db.prepare(
      `INSERT INTO role_versions
         (id, role_id, version, system_prompt, skills_json, allowed_tools_json, hooks_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("v-legacy", "r1", 1, "prompt", "[]", "[]", "{}", 1);

    expect(tableColumns(db, "role_versions")).not.toContain("contract_version");

    migrateRoleContractVersion(db);

    expect(tableColumns(db, "role_versions")).toContain("contract_version");
    const row = db
      .prepare("SELECT contract_version FROM role_versions WHERE id = ?")
      .get("v-legacy") as { contract_version: number };
    // The backfill freezes legacy rows at contract 1 — the only contract that
    // existed before the stamp — NOT the live ENGINE_CONTRACT_VERSION (now 2 after
    // #432). Such a v1 row is later carried forward by the boot sweep's 1→2 step,
    // never re-stamped by the backfill (#236 provenance).
    expect(row.contract_version).toBe(1);
    db.close();
  });

  it("is a no-op on a database that already has the column", () => {
    const db = createDatabase(":memory:");
    expect(() => migrateRoleContractVersion(db)).not.toThrow();
    db.close();
  });
});
