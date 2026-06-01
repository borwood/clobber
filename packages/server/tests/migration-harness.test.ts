import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";
import {
  buildAndRegress,
  dryRunMigration,
  captureShape,
  diffShapes,
} from "../src/migration-harness.ts";

// The harness exercises the upgrade path (old shape on disk → real
// `createDatabase` sequence) that every fresh-`:memory:` migration test skips —
// the blind spot that let #339 ship green and crash on the first real boot.
// Unlike the single-role db-migration-order regression, this drives a POPULATED
// multi-row database through a multi-column downgrade, so the backfills are
// proven across more than one row.
describe("migration harness — populated existing-DB upgrade", () => {
  it("upgrades a populated pre-#236/#213 database without throwing and backfills every row", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-harness-"));
    const path = join(dir, "existing.db");
    try {
      buildAndRegress({
        path,
        seed: (db) => {
          const roles = createRoleStore(db);
          roles.create({ name: "manager", persistent: true });
          roles.create({ name: "worker", persistent: false });
        },
        // Simulate a database predating contract_version (#236), wake programs
        // and default wake program (#213): drop all three from role_versions.
        // Reopening must re-add every column and backfill the populated rows.
        regress: (db) => {
          db.exec("ALTER TABLE role_versions DROP COLUMN contract_version");
          db.exec("ALTER TABLE role_versions DROP COLUMN wake_programs_json");
          db.exec("ALTER TABLE role_versions DROP COLUMN default_wake_program");
        },
      });

      // Reopen through the REAL entrypoint — the buggy #339 migration order
      // throws here (RoleVersionStore prepares an INSERT referencing the
      // not-yet-re-added contract_version column).
      let db!: ReturnType<typeof createDatabase>;
      expect(() => {
        db = createDatabase(path);
      }).not.toThrow();

      const cols = (
        db
          .prepare("PRAGMA table_info(role_versions)")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(cols).toContain("contract_version");
      expect(cols).toContain("wake_programs_json");
      expect(cols).toContain("default_wake_program");

      const versions = db
        .prepare(
          `SELECT r.name AS role_name, rv.contract_version AS cv, rv.wake_programs_json AS wp
             FROM role_versions rv JOIN roles r ON r.id = rv.role_id`,
        )
        .all() as Array<{ role_name: string; cv: number; wp: string }>;
      expect(versions.length).toBe(2);
      // Every row recovered a contract stamp on the upgrade path.
      for (const v of versions) expect(v.cv).toBe(ENGINE_CONTRACT_VERSION);
      // The worker bundle declares wake programs; the upgrade backfills them
      // from the shipped manifest rather than leaving the default '[]'.
      const worker = versions.find((v) => v.role_name === "worker")!;
      expect((JSON.parse(worker.wp) as unknown[]).length).toBeGreaterThan(0);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration harness — per-role model column upgrade (#423)", () => {
  it("re-adds the roles.model column on an existing populated DB and preserves rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-model-"));
    const path = join(dir, "existing.db");
    try {
      buildAndRegress({
        path,
        seed: (db) => {
          const roles = createRoleStore(db);
          roles.create({ name: "manager", persistent: true, model: "opus" });
          roles.create({ name: "worker", persistent: false });
        },
        // Simulate a database predating the per-role model knob (#423): drop the
        // column so reopening must re-add it and leave every row intact.
        regress: (db) => {
          db.exec("ALTER TABLE roles DROP COLUMN model");
        },
      });

      let db!: ReturnType<typeof createDatabase>;
      expect(() => {
        db = createDatabase(path);
      }).not.toThrow();

      const cols = (
        db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(cols).toContain("model");

      // The rows survived the upgrade; the dropped column comes back NULL (unset
      // = today's behavior), never resurrecting the pre-regress value.
      const store = createRoleStore(db);
      const all = store.list();
      expect(all.length).toBe(2);
      for (const r of all) expect(r.model).toBeUndefined();

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration harness — dry-run against a copy", () => {
  it("reports the pending migration's diff and never writes the source file", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-dryrun-"));
    const livePath = join(dir, "live.db");
    const copyPath = join(dir, "copy.db");
    try {
      // A populated database stuck in an old (pre-#236) shape on disk.
      buildAndRegress({
        path: livePath,
        seed: (db) => {
          createRoleStore(db).create({ name: "manager", persistent: true });
        },
        regress: (db) => {
          db.exec("ALTER TABLE role_versions DROP COLUMN contract_version");
        },
      });

      const liveBytesBefore = readFileSync(livePath);

      const result = dryRunMigration({ livePath, copyPath });

      // The diff surfaces the column the pending migration would re-add.
      const roleVersionsChange = result.diff.columnChanges.find(
        (c) => c.table === "role_versions",
      );
      expect(roleVersionsChange).toBeDefined();
      expect(roleVersionsChange!.added).toContain("contract_version");
      expect(result.before.tables["role_versions"]!.columns).not.toContain(
        "contract_version",
      );
      expect(result.after.tables["role_versions"]!.columns).toContain(
        "contract_version",
      );

      // HARD CONSTRAINT: the live file is byte-identical after the dry-run.
      const liveBytesAfter = readFileSync(livePath);
      expect(Buffer.compare(liveBytesBefore, liveBytesAfter)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration harness — shape helpers", () => {
  it("captures and diffs added columns and row-count deltas", () => {
    const before = captureShape(buildMem(["a"]));
    const afterDb = buildMem(["a", "b"]);
    afterDb.prepare("INSERT INTO t (a, b) VALUES (1, 2)").run();
    const after = captureShape(afterDb);

    const diff = diffShapes(before, after);
    const change = diff.columnChanges.find((c) => c.table === "t")!;
    expect(change.added).toEqual(["b"]);
    const delta = diff.rowCountDeltas.find((d) => d.table === "t")!;
    expect(delta).toEqual({ table: "t", before: 0, after: 1 });
  });
});

function buildMem(columns: readonly string[]): ReturnType<typeof createDatabase> {
  const db = createDatabase(":memory:");
  db.exec(`CREATE TABLE t (${columns.map((c) => `${c} INTEGER`).join(", ")})`);
  return db;
}
