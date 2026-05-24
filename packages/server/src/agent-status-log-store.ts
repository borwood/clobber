import type { Database } from "bun:sqlite";

export type AgentStatusLogKind =
  | "status"
  | "phase-transition"
  | "task-snapshot"
  | "note"
  | "final-report"
  | "callback-error"
  | "skill-self-grant"
  | "session-boundary";

export interface AppendStatusLogRequest {
  readonly agent_id: string;
  readonly session_id: string;
  readonly kind: AgentStatusLogKind;
  readonly state: string;
  readonly summary: string;
  readonly event_id?: number;
  readonly details?: Record<string, unknown>;
}

export interface AgentStatusLogEntry {
  readonly id: number;
  readonly agent_id: string;
  readonly session_id: string;
  readonly event_id: number | null;
  readonly kind: AgentStatusLogKind;
  readonly state: string;
  readonly summary: string;
  readonly details: Record<string, unknown> | null;
  readonly created_at: number;
}

export interface ListForAgentOptions {
  readonly limit?: number;
  readonly kind?: AgentStatusLogKind;
  readonly before?: number;
}

export interface AgentStatusLogStore {
  append(req: AppendStatusLogRequest): AgentStatusLogEntry;
  listForAgent(agentId: string, opts?: ListForAgentOptions): AgentStatusLogEntry[];
}

interface Row {
  id: number;
  agent_id: string;
  session_id: string;
  event_id: number | null;
  kind: string;
  state: string;
  summary: string;
  details_json: string | null;
  created_at: number;
}

function rowToEntry(row: Row): AgentStatusLogEntry {
  return {
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    event_id: row.event_id,
    kind: row.kind as AgentStatusLogKind,
    state: row.state,
    summary: row.summary,
    details: row.details_json === null
      ? null
      : (JSON.parse(row.details_json) as Record<string, unknown>),
    created_at: row.created_at,
  };
}

const DEFAULT_LIST_LIMIT = 100;

export function createAgentStatusLogStore(db: Database): AgentStatusLogStore {
  const insertStmt = db.prepare(`
    INSERT INTO agent_status_log
      (agent_id, session_id, event_id, kind, state, summary, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  return {
    append(req) {
      const detailsJson =
        req.details === undefined ? null : JSON.stringify(req.details);
      const eventId = req.event_id === undefined ? null : req.event_id;
      const row = insertStmt.get(
        req.agent_id,
        req.session_id,
        eventId,
        req.kind,
        req.state,
        req.summary,
        detailsJson,
        Date.now(),
      ) as Row;
      return rowToEntry(row);
    },

    listForAgent(agentId, opts) {
      const limit = opts?.limit ?? DEFAULT_LIST_LIMIT;
      const filters: string[] = ["agent_id = ?"];
      const params: (string | number)[] = [agentId];
      if (opts?.kind !== undefined) {
        filters.push("kind = ?");
        params.push(opts.kind);
      }
      if (opts?.before !== undefined) {
        filters.push("created_at < ?");
        params.push(opts.before);
      }
      const sql = `
        SELECT * FROM agent_status_log
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params.push(limit);
      const rows = db.prepare(sql).all(...params) as Row[];
      return rows.map(rowToEntry);
    },
  };
}
