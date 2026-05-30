import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_THEME } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";

// Existing workspaces predate the per-workspace theme column (#369). On upgrade,
// migrateWorkspaceTheme must ALTER TABLE in the dark/emerald default and every
// pre-existing row must load through the store as dark/emerald — not crash, not
// fall back silently. This drives the real createDatabase sequence against a
// shape with the theme column stripped, the same upgrade path the fresh
// `:memory:` config tests never exercise.
describe("theme migration (existing-DB upgrade)", () => {
  it("backfills pre-#369 workspaces to dark/emerald and they load through the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-theme-mig-"));
    const dbPath = join(dir, "existing.db");
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-theme-repo-"));
    mkdirSync(join(repoPath, ".git"));
    try {
      // Build a current-schema DB with a workspace, then drop the theme column to
      // simulate a database created before #369.
      const seed = createDatabase(dbPath);
      const seededWs = createWorkspaceStore(seed).create({
        name: "legacy",
        repo_path: repoPath,
      });
      seed.exec("ALTER TABLE workspaces DROP COLUMN theme");
      seed.close();

      // Reopen through the real entrypoint: the migration must re-add + backfill.
      const db = createDatabase(dbPath);
      const cols = (
        db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(cols).toContain("theme");

      const loaded = createWorkspaceStore(db).get(seededWs.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.theme).toEqual({ ...DEFAULT_WORKSPACE_THEME });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
