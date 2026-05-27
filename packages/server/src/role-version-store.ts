import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { RoleBundleData } from "@clobber/runtime";
import {
  RoleSkillSchema,
  RoleVersionSchema,
  type RoleVersion,
} from "@clobber/shared";
import { z } from "zod";

export interface CreateRoleVersionInput {
  readonly role_id: string;
  readonly version: number;
  readonly framing: string;
  readonly system_prompt: string;
  readonly skills_json: string;
  readonly allowed_tools_json: string;
  readonly allowed_cli_commands_json: string;
  readonly hooks_json: string;
  readonly triggers_json: string;
}

export interface RoleVersionSummary {
  readonly id: string;
  readonly version: number;
  readonly created_at: number;
}

export interface RoleVersionStore {
  create(input: CreateRoleVersionInput): RoleVersion;
  get(id: string): RoleVersion | null;
  listForRole(roleId: string): RoleVersionSummary[];
  loadAsBundle(id: string): RoleBundleData | null;
}

interface Row {
  id: string;
  role_id: string;
  version: number;
  framing: string;
  system_prompt: string;
  skills_json: string;
  allowed_tools_json: string;
  allowed_cli_commands_json: string;
  hooks_json: string;
  triggers_json: string;
  created_at: number;
}

interface RoleNameDescriptionRow {
  name: string;
  description: string | null;
}

const SkillsArraySchema = z.array(RoleSkillSchema);

function rowToVersion(row: Row): RoleVersion {
  return RoleVersionSchema.parse({
    id: row.id,
    role_id: row.role_id,
    version: row.version,
    framing: row.framing,
    system_prompt: row.system_prompt,
    skills_json: row.skills_json,
    allowed_tools_json: row.allowed_tools_json,
    allowed_cli_commands_json: row.allowed_cli_commands_json,
    hooks_json: row.hooks_json,
    triggers_json: row.triggers_json,
    created_at: row.created_at,
  });
}

export function createRoleVersionStore(db: Database): RoleVersionStore {
  const insertStmt = db.prepare(
    `INSERT INTO role_versions
       (id, role_id, version, framing, system_prompt, skills_json, allowed_tools_json, allowed_cli_commands_json, hooks_json, triggers_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare("SELECT * FROM role_versions WHERE id = ?");
  const listForRoleStmt = db.prepare(
    "SELECT id, version, created_at FROM role_versions WHERE role_id = ? ORDER BY version DESC",
  );
  const getRoleStmt = db.prepare(
    "SELECT name, description FROM roles WHERE id = ?",
  );

  return {
    create(input) {
      const id = randomUUID();
      const created_at = Date.now();
      insertStmt.run(
        id,
        input.role_id,
        input.version,
        input.framing,
        input.system_prompt,
        input.skills_json,
        input.allowed_tools_json,
        input.allowed_cli_commands_json,
        input.hooks_json,
        input.triggers_json,
        created_at,
      );
      return rowToVersion(getStmt.get(id) as Row);
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToVersion(row);
    },

    listForRole(roleId) {
      return listForRoleStmt.all(roleId) as RoleVersionSummary[];
    },

    loadAsBundle(id) {
      const row = getStmt.get(id) as Row | null;
      if (row === null) return null;

      const roleRow = getRoleStmt.get(row.role_id) as
        | RoleNameDescriptionRow
        | null;
      if (roleRow === null) return null;

      const skills = SkillsArraySchema.parse(JSON.parse(row.skills_json));
      const data: RoleBundleData = {
        pluginName: roleRow.name,
        ...(roleRow.description === null
          ? {}
          : { description: roleRow.description }),
        framing: row.framing,
        systemPrompt: row.system_prompt,
        skills,
        hooksJson: row.hooks_json,
      };
      return data;
    },
  };
}
