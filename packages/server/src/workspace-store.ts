import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  DEFAULT_SETTING_SOURCES,
  WorkspaceSchema,
  type CreateWorkspaceRequest,
  type SettingSource,
  type Workspace,
} from "@clobber/shared";

export interface WorkspaceStore {
  create(req: CreateWorkspaceRequest): Workspace;
  get(id: string): Workspace | null;
  findByName(name: string): Workspace | null;
  list(): Workspace[];
  updateConfig(
    id: string,
    config: { readonly setting_sources: readonly SettingSource[] },
  ): Workspace | null;
  delete(id: string): boolean;
}

interface Row {
  id: string;
  name: string;
  repo_path: string;
  setting_sources: string;
  created_at: number;
}

function rowToWorkspace(row: Row): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    name: row.name,
    repo_path: row.repo_path,
    setting_sources: JSON.parse(row.setting_sources),
    created_at: row.created_at,
  });
}

export function createWorkspaceStore(db: Database): WorkspaceStore {
  const insertStmt = db.prepare(
    "INSERT INTO workspaces (id, name, repo_path, setting_sources, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const getStmt = db.prepare("SELECT * FROM workspaces WHERE id = ?");
  const findByNameStmt = db.prepare("SELECT * FROM workspaces WHERE name = ?");
  const listStmt = db.prepare(
    "SELECT * FROM workspaces ORDER BY created_at DESC, id DESC",
  );
  const updateConfigStmt = db.prepare(
    "UPDATE workspaces SET setting_sources = ? WHERE id = ?",
  );
  const deleteStmt = db.prepare("DELETE FROM workspaces WHERE id = ?");

  return {
    create(req) {
      const id = randomUUID();
      const created_at = Date.now();
      const sources = req.setting_sources ?? DEFAULT_SETTING_SOURCES;
      insertStmt.run(id, req.name, req.repo_path, JSON.stringify(sources), created_at);
      return {
        id,
        name: req.name,
        repo_path: req.repo_path,
        setting_sources: [...sources],
        created_at,
      };
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToWorkspace(row);
    },

    findByName(name) {
      const row = findByNameStmt.get(name) as Row | null;
      return row === null ? null : rowToWorkspace(row);
    },

    list() {
      const rows = listStmt.all() as Row[];
      return rows.map(rowToWorkspace);
    },

    updateConfig(id, config) {
      const result = updateConfigStmt.run(
        JSON.stringify(config.setting_sources),
        id,
      );
      if (result.changes === 0) return null;
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToWorkspace(row);
    },

    delete(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },
  };
}
