import type { Database } from "bun:sqlite";

export type AgentStatusLogKind =
  | "status"
  | "phase-transition"
  | "task-snapshot"
  | "note"
  | "final-report"
  | "callback-error"
  | "skill-self-grant"
  | "session-boundary"
  | "message"
  | "message-reply";

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
  // Most recent log row of a kind for a session. Keyed by session_id (not
  // agent_id) so it survives the reaper deleting an ephemeral agent — the
  // session row and its final-report rows persist. Used by fireSessionEnded.
  latestForSession(sessionId: string, kind: AgentStatusLogKind): AgentStatusLogEntry | null;
  // All final-report rows across a workspace's sessions, newest first. Scoped
  // via the sessions join (not agent_id) so reports from reaped ephemeral
  // agents stay visible — the manager's triage read interface (`clobber reports`).
  listFinalReportsForWorkspace(workspaceId: string): AgentStatusLogEntry[];
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
  const latestForSessionStmt = db.prepare(`
    SELECT * FROM agent_status_log
    WHERE session_id = ? AND kind = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const finalReportsForWorkspaceStmt = db.prepare(`
    SELECT log.* FROM agent_status_log log
    JOIN sessions s ON s.id = log.session_id
    WHERE log.kind = 'final-report' AND s.workspace_id = ?
    ORDER BY log.created_at DESC, log.id DESC
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

    latestForSession(sessionId, kind) {
      const row = latestForSessionStmt.get(sessionId, kind) as Row | null;
      return row === null ? null : rowToEntry(row);
    },

    listFinalReportsForWorkspace(workspaceId) {
      const rows = finalReportsForWorkspaceStmt.all(workspaceId) as Row[];
      return rows.map(rowToEntry);
    },
  };
}
