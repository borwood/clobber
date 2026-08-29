import type { Database } from "bun:sqlite";
import { createAgentStore } from "./agent-store.ts";

export interface EstablishSingletonAgentsResult {
  readonly createdAgentIds: readonly string[];
}

interface PersistentRoleRow {
  readonly id: string;
  readonly name: string;
}

// A persistent role with a non-zero ceiling (e.g. the manager singleton) is
// meant to exist by construction: its workspace-open trigger (trigger-scheduler
// keys triggers per-agent) is otherwise unreachable until a human hand-spawns
// it. Idempotent: an existing agent count at or above the role's ceiling is
// left alone, so re-running this (repeat call, server restart re-seeding an
// older workspace) never double-instantiates.
export function establishSingletonAgentsForWorkspace(
  db: Database,
  workspaceId: string,
): EstablishSingletonAgentsResult {
  const agents = createAgentStore(db);
  const persistentRoles = db
    .prepare(`SELECT id, name FROM roles WHERE workspace_id = ? AND persistent = 1`)
    .all(workspaceId) as PersistentRoleRow[];
  const getCeiling = db.prepare(
    `SELECT max_concurrent FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?`,
  );
  const countExisting = db.prepare(
    `SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND role_id = ?`,
  );

  const createdAgentIds: string[] = [];
  for (const role of persistentRoles) {
    const ceilingRow = getCeiling.get(workspaceId, role.id) as
      | { max_concurrent: number }
      | null;
    const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
    if (ceiling < 1) continue;
    const existing = countExisting.get(workspaceId, role.id) as { n: number };
    if (existing.n >= ceiling) continue;
    const agent = agents.create({
      workspace_id: workspaceId,
      role_id: role.id,
      label: role.name,
    });
    createdAgentIds.push(agent.id);
  }
  return { createdAgentIds };
}

// Boot-time counterpart to `backfillUnseededWorkspaces` (seed-workspace-roles.ts):
// sweeps every workspace so a workspace whose roles were seeded before this
// feature shipped still gets its singleton agent(s) established on next server
// start. Runs after role/ceiling backfills, which is where new role/ceiling
// rows for older workspaces are created.
export function backfillMissingSingletonAgents(db: Database): void {
  const rows = db.prepare(`SELECT id FROM workspaces`).all() as Array<{ id: string }>;
  for (const row of rows) {
    establishSingletonAgentsForWorkspace(db, row.id);
  }
}
