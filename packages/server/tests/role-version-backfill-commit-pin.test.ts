import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";

// Regression (#349 git-as-truth / #491): backfillRoleVersions must not
// re-backfill commit-pinned roles that already own a role_versions row — that
// would trip UNIQUE (role_id, version) and crash on re-open. After #491
// current_version_id is dropped; the guard uses commit_sha presence.
describe("backfillRoleVersions skips commit-pinned roles (#349/#491)", () => {
  it("reopens a DB with a commit-pinned role that has a version row without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-rv-commit-pin-"));
    const path = join(dir, "existing.db");
    try {
      const seed = createDatabase(path);
      const role = createRoleStore(seed).create({ name: "manager", persistent: true });
      // create() already writes a v1 version row from the shipped bundle.
      // Pin the role to a commit so it's commit-pinned.
      seed.prepare("UPDATE roles SET current_commit_sha = ?, current_commit_branch = ? WHERE id = ?")
        .run("0123456789abcdef0123456789abcdef01234567", "manager", role.id);
      seed.close();

      // Reopen: re-runs the full migration sequence including backfillRoleVersions.
      // The commit-pinned role must NOT be re-backfilled (would trip UNIQUE).
      const db = createDatabase(path);
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?").get(role.id) as { n: number }
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
