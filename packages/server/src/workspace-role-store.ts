import type { Database } from "bun:sqlite";
import {
  RoleSchema,
  WorkspaceRoleCeilingSchema,
  type Role,
  type WorkspaceRoleCeiling,
  type WorkspaceRoleAssignment,
} from "@clobber/shared";

export interface WorkspaceRoleStore {
  setCeiling(workspaceId: string, roleId: string, max: number): WorkspaceRoleCeiling;
  getCeiling(workspaceId: string, roleId: string): WorkspaceRoleCeiling | null;
  listForWorkspace(workspaceId: string): WorkspaceRoleAssignment[];
  removeCeiling(workspaceId: string, roleId: string): boolean;
}

interface CeilingRow {
  workspace_id: string;
  role_id: string;
  max_concurrent: number;
}

interface JoinedRow extends CeilingRow {
  role_name: string;
  role_description: string | null;
  role_permission_mode: string | null;
  role_persistent: number;
  role_workspace_id: string | null;
  role_current_version_id: string | null;
  role_created_at: number;
  current_version_number: number | null;
  current_version_allowed_tools_json: string | null;
}

function rowToCeiling(row: CeilingRow): WorkspaceRoleCeiling {
  return WorkspaceRoleCeilingSchema.parse(row);
}

function joinedRowToAssignment(row: JoinedRow): WorkspaceRoleAssignment {
  const roleInput: Record<string, unknown> = {
    id: row.role_id,
    name: row.role_name,
    persistent: row.role_persistent === 1,
    created_at: row.role_created_at,
  };
  if (row.role_description !== null) roleInput["description"] = row.role_description;
  if (row.role_permission_mode !== null) roleInput["permission_mode"] = row.role_permission_mode;
  if (row.current_version_allowed_tools_json !== null) {
    const tools = JSON.parse(row.current_version_allowed_tools_json) as readonly string[];
    if (tools.length > 0) roleInput["allowed_tools"] = tools;
  }
  if (row.role_workspace_id !== null) roleInput["workspace_id"] = row.role_workspace_id;
  if (row.role_current_version_id !== null) roleInput["current_version_id"] = row.role_current_version_id;
  const role: Role = RoleSchema.parse(roleInput);
  const assignment: WorkspaceRoleAssignment = {
    role,
    max_concurrent: row.max_concurrent,
    ...(row.role_current_version_id === null || row.current_version_number === null
      ? {}
      : {
          current_version: {
            id: row.role_current_version_id,
            version: row.current_version_number,
          },
        }),
  };
  return assignment;
}

export function createWorkspaceRoleStore(db: Database): WorkspaceRoleStore {
  const upsertStmt = db.prepare(
    `INSERT INTO workspace_role_ceilings (workspace_id, role_id, max_concurrent)
     VALUES (?, ?, ?)
     ON CONFLICT (workspace_id, role_id) DO UPDATE SET max_concurrent = excluded.max_concurrent`,
  );
  const getStmt = db.prepare(
    "SELECT * FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?",
  );
  const listStmt = db.prepare(`
    SELECT
      wrc.workspace_id    AS workspace_id,
      wrc.role_id         AS role_id,
      wrc.max_concurrent  AS max_concurrent,
      r.name              AS role_name,
      r.description       AS role_description,
      r.permission_mode   AS role_permission_mode,
      r.persistent        AS role_persistent,
      r.workspace_id      AS role_workspace_id,
      r.current_version_id AS role_current_version_id,
      r.created_at        AS role_created_at,
      cv.version          AS current_version_number,
      cv.allowed_tools_json AS current_version_allowed_tools_json
    FROM workspace_role_ceilings wrc
    JOIN roles r ON r.id = wrc.role_id
    LEFT JOIN role_versions cv ON cv.id = r.current_version_id
    WHERE wrc.workspace_id = ?
    ORDER BY r.created_at DESC, r.id DESC
  `);
  const deleteStmt = db.prepare(
    "DELETE FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?",
  );

  return {
    setCeiling(workspaceId, roleId, max) {
      upsertStmt.run(workspaceId, roleId, max);
      const row = getStmt.get(workspaceId, roleId) as CeilingRow;
      return rowToCeiling(row);
    },

    getCeiling(workspaceId, roleId) {
      const row = getStmt.get(workspaceId, roleId) as CeilingRow | null;
      return row === null ? null : rowToCeiling(row);
    },

    listForWorkspace(workspaceId) {
      const rows = listStmt.all(workspaceId) as JoinedRow[];
      return rows.map(joinedRowToAssignment);
    },

    removeCeiling(workspaceId, roleId) {
      const result = deleteStmt.run(workspaceId, roleId);
      return result.changes > 0;
    },
  };
}
