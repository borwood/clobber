import type { Database } from "bun:sqlite";
import type { AgentState, AgentStatus } from "@clobber/shared";

export interface UpsertAgentStatusRequest {
  readonly session_id: string;
  readonly state: AgentState;
  readonly summary: string;
  readonly details?: Record<string, unknown>;
}

export interface AgentStatusStore {
  upsert(req: UpsertAgentStatusRequest): AgentStatus;
  get(sessionId: string): AgentStatus | null;
}

interface Row {
  session_id: string;
  state: string;
  summary: string;
  details_json: string | null;
  updated_at: number;
}

function rowToStatus(row: Row): AgentStatus {
  const out: AgentStatus = {
    session_id: row.session_id,
    state: row.state as AgentState,
    summary: row.summary,
    updated_at: row.updated_at,
    ...(row.details_json === null
      ? {}
      : { details: JSON.parse(row.details_json) as Record<string, unknown> }),
  };
  return out;
}

export function createAgentStatusStore(db: Database): AgentStatusStore {
  const upsertStmt = db.prepare(`
    INSERT INTO agent_statuses (session_id, state, summary, details_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      state        = excluded.state,
      summary      = excluded.summary,
      details_json = excluded.details_json,
      updated_at   = excluded.updated_at
  `);
  const getStmt = db.prepare("SELECT * FROM agent_statuses WHERE session_id = ?");

  return {
    upsert(req) {
      const updated_at = Date.now();
      const detailsJson = req.details === undefined ? null : JSON.stringify(req.details);
      upsertStmt.run(req.session_id, req.state, req.summary, detailsJson, updated_at);
      return {
        session_id: req.session_id,
        state: req.state,
        summary: req.summary,
        updated_at,
        ...(req.details === undefined ? {} : { details: req.details }),
      };
    },

    get(sessionId) {
      const row = getStmt.get(sessionId) as Row | null;
      return row === null ? null : rowToStatus(row);
    },
  };
}
