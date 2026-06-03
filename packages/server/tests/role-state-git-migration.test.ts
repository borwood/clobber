import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { ensureUpstreamRoleRepo, loadRoleBundleAtCommit } from "../src/role-repo.ts";
import { createWorkspaceRoleRepos } from "../src/workspace-role-repos.ts";
import { roleSnapshotToContract } from "../src/role-tree.ts";
import { snapshotShippedBundle } from "../src/role-version-snapshot.ts";
import { enumerateShippedRoles } from "@clobber/runtime";
import { migrateRoleStateToWorkspaceRepos } from "../src/role-state-git-migration.ts";
import { configureRoleEmbodiment } from "../src/role-embodiment-config.ts";
import { resolveCurrentRoleVersion } from "../src/resolve-role-content.ts";
import { createRoleContentCache } from "../src/role-content-cache.ts";

// #351 — forward-only migration of role state into per-workspace fork repos.
// A row-backed workspace role becomes a NEW commit in its workspace clone; a
// null-workspace global role is pinned to its upstream `<name>-default` fork
// (the ancestor); already-commit-pinned roles only need their clone ensured.
// NON-NEGOTIABLE: never destructive — `role_versions` rows are retained as the
// path back (and sessions resume off them).

describe("role-state git migration (#351)", () => {
  let root: string;
  let upstreamDir: string;
  let reposBaseDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clobber-mig-"));
    upstreamDir = join(root, "upstream");
    reposBaseDir = join(root, "role-repos");
    ensureUpstreamRoleRepo(upstreamDir);
    db = createDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function run() {
    const upstream = ensureUpstreamRoleRepo(upstreamDir);
    const workspaceRepos = createWorkspaceRoleRepos({ upstreamDir, reposBaseDir });
    return migrateRoleStateToWorkspaceRepos({
      roles: createRoleStore(db),
      roleVersions: createRoleVersionStore(db),
      upstream,
      workspaceRepos,
    });
  }

  it("skips unpinned workspace roles after #491 (no current_version_id to migrate from)", () => {
    const ws = createWorkspaceStore(db).create({ name: "w", repo_path: "/tmp/x" });
    seedWorkspaceRoles(db, ws.id); // no forks → no commit pin, has version rows
    const roles = createRoleStore(db);
    const before = roles.findInWorkspace(ws.id, "manager")!;
    // After #491: no current_version_id column; but version rows exist.
    expect(before.current_commit).toBeUndefined();
    const versionRows = (db
      .prepare("SELECT COUNT(*) n FROM role_versions WHERE role_id = ?")
      .get(before.id) as { n: number }).n;
    expect(versionRows).toBeGreaterThan(0);

    // The migration skips non-commit-pinned roles (no version pointer to read from).
    const result = run();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.migrated).toBe(0);

    // The role remains without a commit pin.
    const after = roles.findInWorkspace(ws.id, "manager")!;
    expect(after.current_commit).toBeUndefined();
  });

  it("pins a null-workspace global role to its upstream default fork (the ancestor)", () => {
    const roleVersions = createRoleVersionStore(db);
    const shipped = enumerateShippedRoles().find((r) => r.manifest.name === "worker")!;
    const snapshot = snapshotShippedBundle({ loaded: shipped, allowedTools: shipped.allowedTools });
    const id = randomUUID();
    // After #491: insert without current_version_id (column dropped).
    db.prepare(
      `INSERT INTO roles (id, name, description, permission_mode, effort, persistent, workspace_id, created_at)
       VALUES (?, 'worker', 'd', null, null, 0, null, ?)`,
    ).run(id, Date.now());
    roleVersions.create({ role_id: id, version: 1, ...snapshot });
    // No pointer update (column gone); pinNullWorkspaceToDefault uses upstream fork.

    const result = run();
    expect(result.pinnedToDefault).toBeGreaterThanOrEqual(1);

    const after = createRoleStore(db).findByName("worker")!;
    const upstream = ensureUpstreamRoleRepo(upstreamDir);
    const fork = upstream.forks.get("worker")!;
    expect(after.current_commit).toEqual({ branch: fork.branch, sha: fork.sha });
  });

  it("after #491: unpinned workspace roles are skipped by migration; content comes from version row fallback", () => {
    const ws = createWorkspaceStore(db).create({ name: "w", repo_path: "/tmp/x" });
    seedWorkspaceRoles(db, ws.id); // no forks → version rows, no commit pin
    const config = configureRoleEmbodiment(db, upstreamDir);
    const { roleRepoDir, workspaceRepos } = config;
    if (roleRepoDir === undefined || workspaceRepos === undefined) {
      throw new Error("expected a configured role repo");
    }
    const roleVersions = createRoleVersionStore(db);
    const result = migrateRoleStateToWorkspaceRepos({
      roles: createRoleStore(db),
      roleVersions,
      upstream: ensureUpstreamRoleRepo(upstreamDir),
      workspaceRepos,
    });
    // After #491: workspace roles are skipped (no version pointer to migrate from).
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.migrated).toBe(0);

    const role = createRoleStore(db).findInWorkspace(ws.id, "manager")!;
    expect(role.current_commit).toBeUndefined();

    // Resolution falls back to the version row via latestForRole — no throw.
    const resolved = resolveCurrentRoleVersion(role, {
      roleVersions,
      roleContentCache: createRoleContentCache(db),
      roleRepoDir,
      workspaceRepos,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.system_prompt.length).toBeGreaterThan(0);
  });

  it("ensures the workspace clone for an already commit-pinned role (source b)", () => {
    const ws = createWorkspaceStore(db).create({ name: "w", repo_path: "/tmp/x" });
    const upstream = ensureUpstreamRoleRepo(upstreamDir);
    const forks = new Map(upstream.forks);
    seedWorkspaceRoles(db, ws.id, forks); // forks present → commit-pinned

    const result = run();
    expect(result.clonesEnsured).toBeGreaterThanOrEqual(1);
    expect(result.migrated).toBe(0);
  });
});
