import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { loadRoleBundle } from "@clobber/runtime";
import { RoleSchema, type CommitRef, type Role, type CreateRoleRequest } from "@clobber/shared";
import { snapshotShippedBundle } from "./role-version-snapshot.ts";
import { createRoleVersionStore } from "./role-version-store.ts";

export interface RoleStore {
  create(req: CreateRoleRequest): Role;
  get(id: string): Role | null;
  findByName(name: string): Role | null;
  findInWorkspace(workspaceId: string, name: string): Role | null;
  list(): Role[];
  listForWorkspace(workspaceId: string): Role[];
  delete(id: string): boolean;
  updateDescription(id: string, description: string): void;
  // #349 — pin a role to a commit in the upstream role repo (git-backed),
  // clearing any row pointer. Embodiment then reads content from the tree at sha.
  pinCommit(id: string, commit: CommitRef): void;
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  permission_mode: string | null;
  effort: string | null;
  persistent: number;
  workspace_id: string | null;
  current_version_id: string | null;
  current_commit_branch: string | null;
  current_commit_sha: string | null;
  created_at: number;
  current_version_allowed_tools_json: string | null;
}

function rowToRole(row: Row): Role {
  const parsed: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    persistent: row.persistent === 1,
    created_at: row.created_at,
  };
  if (row.description !== null) parsed["description"] = row.description;
  if (row.permission_mode !== null) parsed["permission_mode"] = row.permission_mode;
  if (row.current_version_allowed_tools_json !== null) {
    const tools = JSON.parse(row.current_version_allowed_tools_json) as readonly string[];
    if (tools.length > 0) parsed["allowed_tools"] = tools;
  }
  if (row.effort !== null) parsed["effort"] = row.effort;
  if (row.workspace_id !== null) parsed["workspace_id"] = row.workspace_id;
  if (row.current_version_id !== null) parsed["current_version_id"] = row.current_version_id;
  if (row.current_commit_branch !== null && row.current_commit_sha !== null) {
    parsed["current_commit"] = {
      branch: row.current_commit_branch,
      sha: row.current_commit_sha,
    };
  }
  return RoleSchema.parse(parsed);
}

const ROLE_SELECT = `
  SELECT
    r.id, r.name, r.description, r.permission_mode, r.effort,
    r.persistent, r.workspace_id, r.current_version_id,
    r.current_commit_branch, r.current_commit_sha, r.created_at,
    v.allowed_tools_json AS current_version_allowed_tools_json
  FROM roles r
  LEFT JOIN role_versions v ON v.id = r.current_version_id
`;

export function createRoleStore(db: Database): RoleStore {
  const versions = createRoleVersionStore(db);

  const insertStmt = db.prepare(
    "INSERT INTO roles (id, name, description, permission_mode, effort, persistent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const setVersionStmt = db.prepare(
    "UPDATE roles SET current_version_id = ? WHERE id = ?",
  );
  const pinCommitStmt = db.prepare(
    "UPDATE roles SET current_commit_branch = ?, current_commit_sha = ?, current_version_id = NULL WHERE id = ?",
  );
  const getStmt = db.prepare(`${ROLE_SELECT} WHERE r.id = ?`);
  const findByNameStmt = db.prepare(
    `${ROLE_SELECT} WHERE r.name = ? AND r.workspace_id IS NULL`,
  );
  const findInWorkspaceStmt = db.prepare(
    `${ROLE_SELECT} WHERE r.name = ? AND r.workspace_id = ?`,
  );
  const listStmt = db.prepare(
    `${ROLE_SELECT} ORDER BY r.created_at DESC, r.id DESC`,
  );
  const listForWorkspaceStmt = db.prepare(
    `${ROLE_SELECT} WHERE r.workspace_id = ? ORDER BY r.name ASC`,
  );
  const deleteStmt = db.prepare("DELETE FROM roles WHERE id = ?");
  const updateDescriptionStmt = db.prepare(
    "UPDATE roles SET description = ? WHERE id = ?",
  );

  return {
    create(req) {
      const id = randomUUID();
      const created_at = Date.now();
      const description = req.description === undefined ? null : req.description;
      const permission_mode = req.permission_mode === undefined ? null : req.permission_mode;
      const effort = req.effort === undefined ? null : req.effort;
      insertStmt.run(
        id,
        req.name,
        description,
        permission_mode,
        effort,
        req.persistent ? 1 : 0,
        created_at,
      );

      const shipped = loadRoleBundle(req.name);
      if (shipped !== null) {
        const snapshot = snapshotShippedBundle({
          loaded: shipped,
          allowedTools: req.allowed_tools === undefined ? [] : req.allowed_tools,
        });
        const version = versions.create({
          role_id: id,
          version: 1,
          ...snapshot,
        });
        setVersionStmt.run(version.id, id);
      }

      return rowToRole(getStmt.get(id) as Row);
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToRole(row);
    },

    findByName(name) {
      const row = findByNameStmt.get(name) as Row | null;
      return row === null ? null : rowToRole(row);
    },

    findInWorkspace(workspaceId, name) {
      const row = findInWorkspaceStmt.get(name, workspaceId) as Row | null;
      return row === null ? null : rowToRole(row);
    },

    list() {
      const rows = listStmt.all() as Row[];
      return rows.map(rowToRole);
    },

    listForWorkspace(workspaceId) {
      const rows = listForWorkspaceStmt.all(workspaceId) as Row[];
      return rows.map(rowToRole);
    },

    delete(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },

    updateDescription(id, description) {
      updateDescriptionStmt.run(description, id);
    },

    pinCommit(id, commit) {
      pinCommitStmt.run(commit.branch, commit.sha, id);
    },
  };
}
