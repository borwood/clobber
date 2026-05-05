import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { enumerateShippedRoles, type LoadedRole } from "@clobber/runtime";
import { snapshotShippedBundle } from "./role-version-snapshot.ts";
import { createRoleVersionStore } from "./role-version-store.ts";

export interface SeedWorkspaceRolesResult {
  readonly created: number;
  readonly skipped: number;
}

export function seedWorkspaceRoles(
  db: Database,
  workspaceId: string,
): SeedWorkspaceRolesResult {
  const versions = createRoleVersionStore(db);

  const insertRole = db.prepare(
    `INSERT INTO roles (id, name, description, permission_mode, allowed_tools, persistent, workspace_id, current_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setVersion = db.prepare("UPDATE roles SET current_version_id = ? WHERE id = ?");
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
    const roleId = seedSingleRole(db, workspaceId, shipped, {
      insertRole,
      setVersion,
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
  readonly upsertCeiling: ReturnType<Database["prepare"]>;
  readonly createVersion: ReturnType<typeof createRoleVersionStore>["create"];
}

function seedSingleRole(
  _db: Database,
  workspaceId: string,
  shipped: LoadedRole,
  deps: SeedDeps,
): string {
  const id = randomUUID();
  const created_at = Date.now();
  const allowedTools = shipped.manifest.allowedTools ?? [];
  const description = shipped.manifest.description;
  const permissionMode = shipped.manifest.permissionMode ?? null;
  const allowedToolsJson =
    shipped.manifest.allowedTools === undefined
      ? null
      : JSON.stringify(allowedTools);

  deps.insertRole.run(
    id,
    shipped.manifest.name,
    description,
    permissionMode,
    allowedToolsJson,
    shipped.manifest.persistent ? 1 : 0,
    workspaceId,
    null,
    created_at,
  );

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
