import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { WorkspaceSchema, type Workspace, type CreateWorkspaceRequest } from "@clobber/shared";

export interface WorkspaceStore {
  create(req: CreateWorkspaceRequest): Workspace;
  get(id: string): Workspace | null;
  findByName(name: string): Workspace | null;
  list(): Workspace[];
  delete(id: string): boolean;
}

interface Row {
  id: string;
  name: string;
  repo_path: string;
  created_at: number;
}

function rowToWorkspace(row: Row): Workspace {
  return WorkspaceSchema.parse(row);
}

export function createWorkspaceStore(db: Database): WorkspaceStore {
  const insertStmt = db.prepare(
    "INSERT INTO workspaces (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)",
  );
  const getStmt = db.prepare("SELECT * FROM workspaces WHERE id = ?");
  const findByNameStmt = db.prepare("SELECT * FROM workspaces WHERE name = ?");
  const listStmt = db.prepare(
    "SELECT * FROM workspaces ORDER BY created_at DESC, id DESC",
  );
  const deleteStmt = db.prepare("DELETE FROM workspaces WHERE id = ?");

  return {
    create(req) {
      const id = randomUUID();
      const created_at = Date.now();
      insertStmt.run(id, req.name, req.repo_path, created_at);
      return { id, name: req.name, repo_path: req.repo_path, created_at };
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

    delete(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },
  };
}
