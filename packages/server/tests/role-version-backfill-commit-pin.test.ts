import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";

// Regression (#349 git-as-truth): backfillRoleVersions snapshots every role
// with current_version_id IS NULL as version 1. A commit-pinned role
// legitimately has current_version_id NULL while ALREADY owning a
// role_versions row (it is pinned by commit, not by row id). Re-backfilling it
// re-inserts version 1 and trips UNIQUE (role_id, version), crashing boot on a
// server restart after the cutover. The fix excludes commit-pinned roles
// (AND current_commit_sha IS NULL), guarded on column presence.
describe("backfillRoleVersions skips commit-pinned roles (#349)", () => {
  it("reopens a DB with a commit-pinned, version-NULL role without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-rv-commit-pin-"));
    const path = join(dir, "existing.db");
    try {
      const seed = createDatabase(path);
      const role = createRoleStore(seed).create({
        name: "manager",
        persistent: true,
      });
      const versionId = role.current_version_id;
      if (versionId === undefined)
        throw new Error("seeded role has no current_version_id");

      // Simulate the git-as-truth cutover: the role keeps its existing v1
      // role_versions row but is now pinned by commit, so current_version_id
      // is cleared and current_commit_sha is set.
      seed
        .prepare(
          "UPDATE roles SET current_version_id = NULL, current_commit_sha = ? WHERE id = ?",
        )
        .run("0123456789abcdef0123456789abcdef01234567", role.id);
      seed.close();

      // Reopen: re-runs the full migration sequence including
      // backfillRoleVersions. Without the fix this throws
      // "UNIQUE constraint failed: role_versions.role_id, role_versions.version".
      const db = createDatabase(path);
      const count = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?",
          )
          .get(role.id) as { n: number }
      ).n;
      expect(count).toBe(1);

      // The commit pin survives — the role was not re-versioned.
      const pinned = db
        .prepare("SELECT current_commit_sha AS sha FROM roles WHERE id = ?")
        .get(role.id) as { sha: string | null };
      expect(pinned.sha).toBe("0123456789abcdef0123456789abcdef01234567");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
