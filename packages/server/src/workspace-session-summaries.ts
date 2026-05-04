import type { Database } from "bun:sqlite";
import type { AgentState, LatestAgentStatus } from "@clobber/shared";

export interface OpenSessionQuestion {
  readonly id: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly asked_at: number;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly role_name: string;
  readonly label?: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly event_count: number;
  readonly last_event_name?: string;
  readonly ended_at?: number;
  readonly latest_status?: LatestAgentStatus;
  readonly open_question?: OpenSessionQuestion;
}

export interface WorkspaceSessionSummaries {
  list(workspaceId: string): SessionSummary[];
}

interface Row {
  session_id: string;
  role_name: string;
  label: string | null;
  first_seen_at: number;
  last_seen_at: number;
  event_count: number;
  last_event_name: string | null;
  ended_at: number | null;
  status_state: string | null;
  status_summary: string | null;
  status_updated_at: number | null;
  question_id: string | null;
  question_text: string | null;
  question_options_json: string | null;
  question_asked_at: number | null;
}

function pickStatus(row: Row): LatestAgentStatus | undefined {
  if (row.status_state === null) return undefined;
  if (row.status_summary === null) return undefined;
  if (row.status_updated_at === null) return undefined;
  return {
    state: row.status_state as AgentState,
    summary: row.status_summary,
    updated_at: row.status_updated_at,
  };
}

function pickOpenQuestion(row: Row): OpenSessionQuestion | undefined {
  if (row.question_id === null) return undefined;
  if (row.question_text === null) return undefined;
  if (row.question_asked_at === null) return undefined;
  const out: OpenSessionQuestion = {
    id: row.question_id,
    question: row.question_text,
    asked_at: row.question_asked_at,
    ...(row.question_options_json === null
      ? {}
      : { options: JSON.parse(row.question_options_json) as readonly string[] }),
  };
  return out;
}

export function createWorkspaceSessionSummaries(db: Database): WorkspaceSessionSummaries {
  const stmt = db.prepare(`
    SELECT
      s.id AS session_id,
      r.name AS role_name,
      a.label AS label,
      COALESCE(MIN(e.received_at), s.started_at) AS first_seen_at,
      COALESCE(MAX(e.received_at), s.started_at) AS last_seen_at,
      COUNT(e.id) AS event_count,
      s.ended_at AS ended_at,
      (
        SELECT hook_event_name
          FROM events e2
         WHERE e2.session_id = s.id
         ORDER BY e2.id DESC
         LIMIT 1
      ) AS last_event_name,
      st.state      AS status_state,
      st.summary    AS status_summary,
      st.updated_at AS status_updated_at,
      q.id          AS question_id,
      q.question    AS question_text,
      q.options_json AS question_options_json,
      q.asked_at    AS question_asked_at
    FROM sessions s
    JOIN roles r                ON r.id          = s.role_id
    LEFT JOIN agents a          ON a.id          = s.agent_id
    LEFT JOIN events e          ON e.session_id  = s.id
    LEFT JOIN agent_statuses st ON st.session_id = s.id
    LEFT JOIN agent_questions q
      ON q.id = (
        SELECT id FROM agent_questions
         WHERE session_id = s.id AND status = 'pending'
         ORDER BY asked_at DESC, id DESC
         LIMIT 1
      )
    WHERE s.workspace_id = ?
    GROUP BY s.id
    ORDER BY last_seen_at DESC, s.id DESC
  `);

  return {
    list(workspaceId) {
      const rows = stmt.all(workspaceId) as Row[];
      return rows.map((row) => {
        const latest_status = pickStatus(row);
        const open_question = pickOpenQuestion(row);
        return {
          session_id: row.session_id,
          role_name: row.role_name,
          ...(row.label === null ? {} : { label: row.label }),
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
          event_count: row.event_count,
          ...(row.last_event_name === null ? {} : { last_event_name: row.last_event_name }),
          ...(row.ended_at === null ? {} : { ended_at: row.ended_at }),
          ...(latest_status === undefined ? {} : { latest_status }),
          ...(open_question === undefined ? {} : { open_question }),
        };
      });
    },
  };
}
