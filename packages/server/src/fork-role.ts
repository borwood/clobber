import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Role, RoleVersion } from "@clobber/shared";
import { createRoleVersionStore } from "./role-version-store.ts";

export interface ForkRoleResult {
  readonly role_id: string;
  readonly version_id: string;
  readonly version: 1;
}

export function forkRole(
  db: Database,
  source: Role,
  sourceVersion: RoleVersion,
  newName: string,
  workspaceId: string,
): ForkRoleResult {
  const versions = createRoleVersionStore(db);

  const insertRole = db.prepare(
    `INSERT INTO roles (id, name, description, permission_mode, allowed_tools, effort, persistent, workspace_id, current_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setCurrentVersion = db.prepare(
    "UPDATE roles SET current_version_id = ? WHERE id = ?",
  );

  const id = randomUUID();
  const createdAt = Date.now();
  const description = source.description ?? null;
  const permissionMode = source.permission_mode ?? null;
  const allowedToolsJson =
    source.allowed_tools === undefined
      ? null
      : JSON.stringify(source.allowed_tools);
  const effort = source.effort ?? null;

  insertRole.run(
    id,
    newName,
    description,
    permissionMode,
    allowedToolsJson,
    effort,
    source.persistent ? 1 : 0,
    workspaceId,
    null,
    createdAt,
  );

  const newVersion = versions.create({
    role_id: id,
    version: 1,
    system_prompt: sourceVersion.system_prompt,
    skills_json: sourceVersion.skills_json,
    allowed_tools_json: sourceVersion.allowed_tools_json,
    allowed_cli_commands_json: sourceVersion.allowed_cli_commands_json,
    hooks_json: sourceVersion.hooks_json,
    triggers_json: sourceVersion.triggers_json,
  });
  setCurrentVersion.run(newVersion.id, id);

  const sourceCeilingRow = db
    .prepare(
      "SELECT max_concurrent FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?",
    )
    .get(workspaceId, source.id) as { max_concurrent: number } | null;
  const inheritedCeiling = sourceCeilingRow === null ? 1 : sourceCeilingRow.max_concurrent;
  db.prepare(
    `INSERT INTO workspace_role_ceilings (workspace_id, role_id, max_concurrent)
     VALUES (?, ?, ?)
     ON CONFLICT (workspace_id, role_id) DO UPDATE SET max_concurrent = excluded.max_concurrent`,
  ).run(workspaceId, id, inheritedCeiling);

  return { role_id: id, version_id: newVersion.id, version: 1 };
}
