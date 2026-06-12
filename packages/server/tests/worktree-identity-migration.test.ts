/**
 * Real upgrade-path test for the worktree identity migration (#635).
 *
 * Fresh :memory: tests prove nothing about pre-existing databases. This test
 * programmatically builds a pre-#635 agents table (no worktree_branch /
 * worktree_path columns), seeds workspaces and agents via the stores, then
 * boots through the real createDatabase() path and asserts:
 *   (a) createDatabase does not throw on the old-shape DB.
 *   (b) worktree_branch and worktree_path columns are present after boot.
 *   (c) On-policy labelled agents are backfilled with the computed identity.
 *   (d) Off-policy workspace agents stay NULL (no worktree context).
 *   (e) Unlabelled agents in on-policy workspaces stay NULL.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { buildAndRegress } from "../src/migration-harness.ts";

describe("worktree-identity migration — backfill upgrade-path (#635)", () => {
  it("(a-e) columns added; on-policy labelled agents backfilled; off-policy and unlabelled stay NULL", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-635-upgrade-"));
    const dbPath = join(dir, "clobber.db");
    const repoPath = "/tmp/clobber-635-test-repo";

    try {
      let onLabelledId!: string;
      let onUnlabelledId!: string;
      let offLabelledId!: string;

      buildAndRegress({
        path: dbPath,
        seed: (db) => {
          const ws = createWorkspaceStore(db);
          const roles = createRoleStore(db);
          const agents = createAgentStore(db);
          const role = roles.create({ name: "worker", persistent: false });

          // on-policy workspace + labelled agent → should be backfilled
          const wsOn = ws.create({ name: "ws-on", repo_path: repoPath });
          ws.updateConfig(wsOn.id, { spawn_worktree: { kind: "on" } });
          onLabelledId = agents.create({ workspace_id: wsOn.id, role_id: role.id, label: "635" }).id;

          // on-policy workspace + unlabelled agent → stays NULL
          onUnlabelledId = agents.create({ workspace_id: wsOn.id, role_id: role.id }).id;

          // off-policy workspace + labelled agent → stays NULL
          const wsOff = ws.create({ name: "ws-off", repo_path: repoPath + "-off" });
          offLabelledId = agents.create({ workspace_id: wsOff.id, role_id: role.id, label: "off-agent" }).id;
        },
        // Simulate pre-#635 DB: drop the new columns if present (no-op if absent).
        regress: (db) => {
          const cols = (
            db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>
          ).map((r) => r.name);
          if (cols.includes("worktree_branch")) db.exec("ALTER TABLE agents DROP COLUMN worktree_branch");
          if (cols.includes("worktree_path")) db.exec("ALTER TABLE agents DROP COLUMN worktree_path");
        },
      });

      // (a) reopen through the real migration path.
      const db = createDatabase(dbPath);

      // (b) columns present after boot.
      const cols = (
        db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(cols).toContain("worktree_branch");
      expect(cols).toContain("worktree_path");

      // (c) on-policy labelled → backfilled with computed identity.
      const onLabelled = db
        .prepare("SELECT worktree_branch, worktree_path FROM agents WHERE id = ?")
        .get(onLabelledId) as { worktree_branch: string | null; worktree_path: string | null };
      expect(onLabelled.worktree_branch).toBe("clobber/635");
      const expectedPath = join(dirname(repoPath), `${basename(repoPath)}-worktrees`, "635");
      expect(onLabelled.worktree_path).toBe(expectedPath);

      // (d) on-policy unlabelled → NULL.
      const onUnlabelled = db
        .prepare("SELECT worktree_branch, worktree_path FROM agents WHERE id = ?")
        .get(onUnlabelledId) as { worktree_branch: string | null; worktree_path: string | null };
      expect(onUnlabelled.worktree_branch).toBeNull();
      expect(onUnlabelled.worktree_path).toBeNull();

      // (e) off-policy labelled → NULL.
      const offLabelled = db
        .prepare("SELECT worktree_branch, worktree_path FROM agents WHERE id = ?")
        .get(offLabelledId) as { worktree_branch: string | null; worktree_path: string | null };
      expect(offLabelled.worktree_branch).toBeNull();
      expect(offLabelled.worktree_path).toBeNull();

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
