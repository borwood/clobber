import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { RoleSchema, type Role, type CreateRoleRequest } from "@clobber/shared";

export interface RoleStore {
  create(req: CreateRoleRequest): Role;
  get(id: string): Role | null;
  findByName(name: string): Role | null;
  list(): Role[];
  delete(id: string): boolean;
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  permission_mode: string | null;
  allowed_tools: string | null;
  persistent: number;
  created_at: number;
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
  if (row.allowed_tools !== null) parsed["allowed_tools"] = JSON.parse(row.allowed_tools);
  return RoleSchema.parse(parsed);
}

export function createRoleStore(db: Database): RoleStore {
  const insertStmt = db.prepare(
    "INSERT INTO roles (id, name, description, permission_mode, allowed_tools, persistent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const getStmt = db.prepare("SELECT * FROM roles WHERE id = ?");
  const findByNameStmt = db.prepare("SELECT * FROM roles WHERE name = ?");
  const listStmt = db.prepare(
    "SELECT * FROM roles ORDER BY created_at DESC, id DESC",
  );
  const deleteStmt = db.prepare("DELETE FROM roles WHERE id = ?");

  return {
    create(req) {
      const id = randomUUID();
      const created_at = Date.now();
      const description = req.description === undefined ? null : req.description;
      const permission_mode = req.permission_mode === undefined ? null : req.permission_mode;
      const allowed_tools = req.allowed_tools === undefined ? null : JSON.stringify(req.allowed_tools);
      insertStmt.run(
        id,
        req.name,
        description,
        permission_mode,
        allowed_tools,
        req.persistent ? 1 : 0,
        created_at,
      );
      const row = getStmt.get(id) as Row;
      return rowToRole(row);
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToRole(row);
    },

    findByName(name) {
      const row = findByNameStmt.get(name) as Row | null;
      return row === null ? null : rowToRole(row);
    },

    list() {
      const rows = listStmt.all() as Row[];
      return rows.map(rowToRole);
    },

    delete(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },
  };
}
