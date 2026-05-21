import type { Database } from "bun:sqlite";

export type DispatchOutcome =
  | "spawned"
  | "injected"
  | "skipped-busy"
  | "skipped-at-capacity"
  | "errored"
  | "unsupported-kind"
  | "disabled-by-workspace";

export interface AppendDispatchInput {
  readonly workspace_id: string;
  readonly role_id: string;
  readonly agent_id: string;
  readonly trigger_kind: string;
  readonly trigger_payload: unknown;
  readonly fired_at: number;
  readonly dispatch_outcome: DispatchOutcome;
  readonly session_id?: string;
  readonly error?: string;
}

export interface DispatchRow {
  readonly id: number;
  readonly workspace_id: string;
  readonly role_id: string;
  readonly agent_id: string;
  readonly trigger_kind: string;
  readonly trigger_payload: unknown;
  readonly fired_at: number;
  readonly dispatch_outcome: DispatchOutcome;
  readonly session_id?: string;
  readonly error?: string;
}

export interface TriggerDispatchStore {
  append(input: AppendDispatchInput): number;
  listForAgent(agentId: string): readonly DispatchRow[];
  listForWorkspace(workspaceId: string): readonly DispatchRow[];
}

interface Row {
  id: number;
  workspace_id: string;
  role_id: string;
  agent_id: string;
  trigger_kind: string;
  trigger_payload_json: string;
  fired_at: number;
  dispatch_outcome: string;
  session_id: string | null;
  error: string | null;
}

function rowToDispatch(row: Row): DispatchRow {
  const out: DispatchRow = {
    id: row.id,
    workspace_id: row.workspace_id,
    role_id: row.role_id,
    agent_id: row.agent_id,
    trigger_kind: row.trigger_kind,
    trigger_payload: JSON.parse(row.trigger_payload_json),
    fired_at: row.fired_at,
    dispatch_outcome: row.dispatch_outcome as DispatchOutcome,
    ...(row.session_id === null ? {} : { session_id: row.session_id }),
    ...(row.error === null ? {} : { error: row.error }),
  };
  return out;
}

export function createTriggerDispatchStore(db: Database): TriggerDispatchStore {
  const insertStmt = db.prepare(
    `INSERT INTO trigger_dispatches
       (workspace_id, role_id, agent_id, trigger_kind, trigger_payload_json, fired_at, dispatch_outcome, session_id, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listForAgentStmt = db.prepare(
    "SELECT * FROM trigger_dispatches WHERE agent_id = ? ORDER BY fired_at DESC, id DESC",
  );
  const listForWorkspaceStmt = db.prepare(
    "SELECT * FROM trigger_dispatches WHERE workspace_id = ? ORDER BY fired_at DESC, id DESC",
  );

  return {
    append(input) {
      const sessionId = input.session_id === undefined ? null : input.session_id;
      const error = input.error === undefined ? null : input.error;
      const result = insertStmt.run(
        input.workspace_id,
        input.role_id,
        input.agent_id,
        input.trigger_kind,
        JSON.stringify(input.trigger_payload),
        input.fired_at,
        input.dispatch_outcome,
        sessionId,
        error,
      );
      return Number(result.lastInsertRowid);
    },
    listForAgent(agentId) {
      const rows = listForAgentStmt.all(agentId) as Row[];
      return rows.map(rowToDispatch);
    },
    listForWorkspace(workspaceId) {
      const rows = listForWorkspaceStmt.all(workspaceId) as Row[];
      return rows.map(rowToDispatch);
    },
  };
}
