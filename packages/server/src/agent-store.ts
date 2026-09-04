import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { AgentSchema, type Agent, type CreateAgentRequest } from "@clobber/shared";

export interface AgentStore {
  create(req: CreateAgentRequest): Agent;
  get(id: string): Agent | null;
  delete(id: string): boolean;
  listForWorkspace(workspaceId: string): Agent[];
  setWorktreeIdentity(id: string, branch: string, path: string): void;
  updateLabel(id: string, label: string): void;
}

interface Row {
  id: string;
  workspace_id: string;
  role_id: string;
  label: string | null;
  spawner_agent_id: string | null;
  created_at: number;
  worktree_branch: string | null;
  worktree_path: string | null;
}

function rowToAgent(row: Row): Agent {
  const input: Record<string, unknown> = {
    id: row.id,
    workspace_id: row.workspace_id,
    role_id: row.role_id,
    created_at: row.created_at,
  };
  if (row.label !== null) input["label"] = row.label;
  if (row.spawner_agent_id !== null) input["spawner_agent_id"] = row.spawner_agent_id;
  if (row.worktree_branch !== null) input["worktree_branch"] = row.worktree_branch;
  if (row.worktree_path !== null) input["worktree_path"] = row.worktree_path;
  return AgentSchema.parse(input);
}

export function createAgentStore(db: Database): AgentStore {
  const insertStmt = db.prepare(
    "INSERT INTO agents (id, workspace_id, role_id, label, spawner_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const getStmt = db.prepare("SELECT * FROM agents WHERE id = ?");
  const listStmt = db.prepare(
    "SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC",
  );
  const deleteStmt = db.prepare("DELETE FROM agents WHERE id = ?");
  const setWorktreeStmt = db.prepare(
    "UPDATE agents SET worktree_branch = ?, worktree_path = ? WHERE id = ?",
  );
  const updateLabelStmt = db.prepare("UPDATE agents SET label = ? WHERE id = ?");

  return {
    create(req) {
      const id = randomUUID();
      const created_at = Date.now();
      const label = req.label === undefined ? null : req.label;
      const spawnerAgentId = req.spawner_agent_id === undefined ? null : req.spawner_agent_id;
      insertStmt.run(id, req.workspace_id, req.role_id, label, spawnerAgentId, created_at);
      const out: Record<string, unknown> = {
        id,
        workspace_id: req.workspace_id,
        role_id: req.role_id,
        created_at,
      };
      if (req.label !== undefined) out["label"] = req.label;
      if (req.spawner_agent_id !== undefined) out["spawner_agent_id"] = req.spawner_agent_id;
      return AgentSchema.parse(out);
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToAgent(row);
    },

    listForWorkspace(workspaceId) {
      const rows = listStmt.all(workspaceId) as Row[];
      return rows.map(rowToAgent);
    },

    delete(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },

    setWorktreeIdentity(id, branch, path) {
      setWorktreeStmt.run(branch, path, id);
    },

    updateLabel(id, label) {
      updateLabelStmt.run(label, id);
    },
  };
}
