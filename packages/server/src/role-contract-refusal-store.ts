import type { Database } from "bun:sqlite";
import type { RoleContractIncompatibility } from "./role-contract-compat.ts";

// #237 — the durable audit record of a refuse-with-signal. A contract refusal
// fires before any session exists (and must also fire at the session-less
// engine-adopt boundary, #239), so it cannot ride the session-scoped
// agent_status_log. This is its own session-independent sink, shaped as
// queryable provenance (rhymes with #221): the cause — role, pinned version,
// and both contract versions — is named in first-class columns so a refusal can
// always be diagnosed. The manager triages these the way `clobber reports`
// triages final-report rows.

export interface AppendRoleContractRefusalRequest {
  readonly workspace_id: string;
  // Absent at the adopt boundary (no agent yet); present on a spawn refusal.
  readonly agent_id?: string;
  readonly role_id: string;
  readonly cause: RoleContractIncompatibility;
}

export interface RoleContractRefusal {
  readonly id: number;
  readonly workspace_id: string;
  readonly agent_id: string | null;
  readonly role_id: string;
  readonly role_name: string;
  readonly role_version_id: string;
  readonly authored_contract_version: number;
  readonly engine_contract_version: number;
  readonly created_at: number;
}

export interface RoleContractRefusalStore {
  append(req: AppendRoleContractRefusalRequest): RoleContractRefusal;
  listForWorkspace(workspaceId: string): RoleContractRefusal[];
}

interface Row {
  id: number;
  workspace_id: string;
  agent_id: string | null;
  role_id: string;
  role_name: string;
  role_version_id: string;
  authored_contract_version: number;
  engine_contract_version: number;
  created_at: number;
}

export function createRoleContractRefusalStore(db: Database): RoleContractRefusalStore {
  const insertStmt = db.prepare(`
    INSERT INTO role_contract_refusals
      (workspace_id, agent_id, role_id, role_name, role_version_id,
       authored_contract_version, engine_contract_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  const listForWorkspaceStmt = db.prepare(`
    SELECT * FROM role_contract_refusals
    WHERE workspace_id = ?
    ORDER BY created_at DESC, id DESC
  `);

  return {
    append(req) {
      const agentId = req.agent_id === undefined ? null : req.agent_id;
      const row = insertStmt.get(
        req.workspace_id,
        agentId,
        req.role_id,
        req.cause.role_name,
        req.cause.role_version_id,
        req.cause.authored_contract_version,
        req.cause.engine_contract_version,
        Date.now(),
      ) as Row;
      return row;
    },

    listForWorkspace(workspaceId) {
      return listForWorkspaceStmt.all(workspaceId) as Row[];
    },
  };
}
