import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { loadRoleBundle, type LoadedRole } from "@clobber/runtime";
import {
  RoleVersionSchema,
  type RoleVersion,
} from "@clobber/shared";

export interface CreateRoleVersionInput {
  readonly role_id: string;
  readonly version: number;
  readonly system_prompt: string;
  readonly skills_json: string;
  readonly allowed_tools_json: string;
  readonly hooks_json: string;
}

export interface RoleVersionStore {
  create(input: CreateRoleVersionInput): RoleVersion;
  get(id: string): RoleVersion | null;
  loadAsBundle(id: string): LoadedRole | null;
}

interface Row {
  id: string;
  role_id: string;
  version: number;
  system_prompt: string;
  skills_json: string;
  allowed_tools_json: string;
  hooks_json: string;
  created_at: number;
}

function rowToVersion(row: Row): RoleVersion {
  return RoleVersionSchema.parse({
    id: row.id,
    role_id: row.role_id,
    version: row.version,
    system_prompt: row.system_prompt,
    skills_json: row.skills_json,
    allowed_tools_json: row.allowed_tools_json,
    hooks_json: row.hooks_json,
    created_at: row.created_at,
  });
}

export function createRoleVersionStore(db: Database): RoleVersionStore {
  const insertStmt = db.prepare(
    `INSERT INTO role_versions
       (id, role_id, version, system_prompt, skills_json, allowed_tools_json, hooks_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare("SELECT * FROM role_versions WHERE id = ?");
  const getRoleNameStmt = db.prepare(
    "SELECT name FROM roles WHERE id = ?",
  );

  return {
    create(input) {
      const id = randomUUID();
      const created_at = Date.now();
      insertStmt.run(
        id,
        input.role_id,
        input.version,
        input.system_prompt,
        input.skills_json,
        input.allowed_tools_json,
        input.hooks_json,
        created_at,
      );
      return rowToVersion(getStmt.get(id) as Row);
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToVersion(row);
    },

    loadAsBundle(id) {
      const row = getStmt.get(id) as Row | null;
      if (row === null) return null;

      const roleNameRow = getRoleNameStmt.get(row.role_id) as
        | { name: string }
        | null;
      if (roleNameRow === null) return null;

      const shipped = loadRoleBundle(roleNameRow.name);
      if (shipped === null) return null;

      return {
        bundleRoot: shipped.bundleRoot,
        manifest: shipped.manifest,
        systemPrompt: row.system_prompt,
      };
    },
  };
}
