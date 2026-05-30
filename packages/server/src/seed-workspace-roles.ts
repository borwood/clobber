import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { enumerateShippedRoles, type LoadedRole } from "@clobber/runtime";
import { snapshotShippedBundle } from "./role-version-snapshot.ts";
import { createRoleVersionStore } from "./role-version-store.ts";
import type { ForkRef } from "./role-repo.ts";

export interface SeedWorkspaceRolesResult {
  readonly created: number;
  readonly skipped: number;
}

// #385 — `forks` (role name → its fork tip in the upstream role repo) flips a
// seeded role from row-backed to git-backed: present → the role is pinned to its
// commit and embodiment reads content from the tree; absent → the pre-#349
// `role_versions` row is written. Production always materializes the repo, so it
// embodies from git by default; a no-repo run (an in-memory DB) keeps the row.
export function seedWorkspaceRoles(
  db: Database,
  workspaceId: string,
  forks?: ReadonlyMap<string, ForkRef>,
): SeedWorkspaceRolesResult {
  const versions = createRoleVersionStore(db);

  const insertRole = db.prepare(
    `INSERT INTO roles (id, name, description, permission_mode, effort, persistent, workspace_id, current_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setVersion = db.prepare("UPDATE roles SET current_version_id = ? WHERE id = ?");
  const pinCommit = db.prepare(
    "UPDATE roles SET current_commit_branch = ?, current_commit_sha = ? WHERE id = ?",
  );
  const upsertCeiling = db.prepare(
    `INSERT INTO workspace_role_ceilings (workspace_id, role_id, max_concurrent)
     VALUES (?, ?, ?)
     ON CONFLICT (workspace_id, role_id) DO UPDATE SET max_concurrent = excluded.max_concurrent`,
  );
  const findExisting = db.prepare(
    "SELECT id FROM roles WHERE workspace_id = ? AND name = ?",
  );

  let created = 0;
  let skipped = 0;

  for (const shipped of enumerateShippedRoles()) {
    const existing = findExisting.get(workspaceId, shipped.manifest.name) as
      | { id: string }
      | null;
    if (existing !== null) {
      skipped += 1;
      continue;
    }
    const roleId = seedSingleRole(db, workspaceId, shipped, forks, {
      insertRole,
      setVersion,
      pinCommit,
      upsertCeiling,
      createVersion: versions.create,
    });
    upsertCeiling.run(workspaceId, roleId, shipped.manifest.defaultCeiling);
    created += 1;
  }

  return { created, skipped };
}

interface SeedDeps {
  readonly insertRole: ReturnType<Database["prepare"]>;
  readonly setVersion: ReturnType<Database["prepare"]>;
  readonly pinCommit: ReturnType<Database["prepare"]>;
  readonly upsertCeiling: ReturnType<Database["prepare"]>;
  readonly createVersion: ReturnType<typeof createRoleVersionStore>["create"];
}

function seedSingleRole(
  _db: Database,
  workspaceId: string,
  shipped: LoadedRole,
  forks: ReadonlyMap<string, ForkRef> | undefined,
  deps: SeedDeps,
): string {
  const id = randomUUID();
  const created_at = Date.now();
  const allowedTools = shipped.allowedTools;
  const description = shipped.manifest.description;
  const permissionMode = shipped.permissionMode === undefined ? null : shipped.permissionMode;
  const effort = shipped.manifest.effort === undefined ? null : shipped.manifest.effort;

  deps.insertRole.run(
    id,
    shipped.manifest.name,
    description,
    permissionMode,
    effort,
    shipped.manifest.persistent ? 1 : 0,
    workspaceId,
    null,
    created_at,
  );

  if (forks !== undefined) {
    const fork = forks.get(shipped.manifest.name);
    // The fork map is built from the same shipped-role set, so a missing entry
    // is a materialization bug, not a fallback case — surface it.
    if (fork === undefined) {
      throw new Error(`no upstream fork branch for shipped role '${shipped.manifest.name}'`);
    }
    deps.pinCommit.run(fork.branch, fork.sha, id);
    return id;
  }

  const snapshot = snapshotShippedBundle({ loaded: shipped, allowedTools });
  const version = deps.createVersion({
    role_id: id,
    version: 1,
    ...snapshot,
  });
  deps.setVersion.run(version.id, id);

  return id;
}

export function backfillUnseededWorkspaces(db: Database): void {
  const rows = db
    .prepare(
      `SELECT w.id AS id
         FROM workspaces w
         WHERE NOT EXISTS (
           SELECT 1 FROM roles r WHERE r.workspace_id = w.id
         )`,
    )
    .all() as Array<{ id: string }>;
  for (const row of rows) {
    seedWorkspaceRoles(db, row.id);
  }
}
