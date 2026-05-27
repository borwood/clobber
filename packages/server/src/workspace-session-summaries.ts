import type { Database } from "bun:sqlite";
import type {
  AgentState,
  AskQuestion,
  LatestAgentStatus,
  QuestionStatus,
  RoleVersionRef,
} from "@clobber/shared";

export interface OpenSessionQuestion {
  readonly id: string;
  readonly questions: readonly AskQuestion[];
  readonly asked_at: number;
  // `pending` while the asking agent is parked on it; `timed_out` once the wait
  // window lapsed but the widget stays actionable, since a late answer still
  // routes back into the session (#183).
  readonly status: Extract<QuestionStatus, "pending" | "timed_out">;
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
  readonly was_live_at_shutdown?: boolean;
  readonly latest_status?: LatestAgentStatus;
  readonly open_question?: OpenSessionQuestion;
  readonly role_version?: RoleVersionRef;
  readonly role_current_version?: RoleVersionRef;
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
  was_live_at_shutdown: number;
  status_state: string | null;
  status_summary: string | null;
  status_updated_at: number | null;
  question_id: string | null;
  question_questions_json: string | null;
  question_asked_at: number | null;
  question_status: string | null;
  pinned_version_id: string | null;
  pinned_version_number: number | null;
  current_version_id: string | null;
  current_version_number: number | null;
}

function pickVersionRef(
  id: string | null,
  version: number | null,
): RoleVersionRef | undefined {
  if (id === null || version === null) return undefined;
  return { id, version };
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
  if (row.question_questions_json === null) return undefined;
  if (row.question_asked_at === null) return undefined;
  if (row.question_status === null) return undefined;
  return {
    id: row.question_id,
    questions: JSON.parse(row.question_questions_json) as readonly AskQuestion[],
    asked_at: row.question_asked_at,
    status: row.question_status as Extract<QuestionStatus, "pending" | "timed_out">,
  };
}

export function createWorkspaceSessionSummaries(db: Database): WorkspaceSessionSummaries {
  const stmt = db.prepare(`
    SELECT
      s.id AS session_id,
      r.name AS role_name,
      -- Prefer session's own label (denormalized at spawn) so the name
      -- survives non-persistent agent deletion on end. Fall back to the
      -- live agent's label only for sessions written before this column
      -- existed AND whose agent is still around.
      COALESCE(s.label, a.label) AS label,
      COALESCE(MIN(e.received_at), s.started_at) AS first_seen_at,
      COALESCE(MAX(e.received_at), s.started_at) AS last_seen_at,
      COUNT(e.id) AS event_count,
      s.ended_at AS ended_at,
      s.was_live_at_shutdown AS was_live_at_shutdown,
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
      q.id             AS question_id,
      q.questions_json AS question_questions_json,
      q.asked_at       AS question_asked_at,
      q.status         AS question_status,
      pv.id         AS pinned_version_id,
      pv.version    AS pinned_version_number,
      cv.id         AS current_version_id,
      cv.version    AS current_version_number
    FROM sessions s
    JOIN roles r                ON r.id          = s.role_id
    LEFT JOIN agents a          ON a.id          = s.agent_id
    LEFT JOIN events e          ON e.session_id  = s.id
    LEFT JOIN agent_statuses st ON st.session_id = s.id
    LEFT JOIN role_versions pv  ON pv.id         = s.role_version_id
    LEFT JOIN role_versions cv  ON cv.id         = r.current_version_id
    LEFT JOIN agent_questions q
      ON q.id = (
        SELECT id FROM agent_questions
         WHERE session_id = s.id AND status IN ('pending', 'timed_out')
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
        const role_version = pickVersionRef(
          row.pinned_version_id,
          row.pinned_version_number,
        );
        const role_current_version = pickVersionRef(
          row.current_version_id,
          row.current_version_number,
        );
        return {
          session_id: row.session_id,
          role_name: row.role_name,
          ...(row.label === null ? {} : { label: row.label }),
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
          event_count: row.event_count,
          ...(row.last_event_name === null ? {} : { last_event_name: row.last_event_name }),
          ...(row.ended_at === null ? {} : { ended_at: row.ended_at }),
          ...(row.was_live_at_shutdown === 1 ? { was_live_at_shutdown: true } : {}),
          ...(latest_status === undefined ? {} : { latest_status }),
          ...(open_question === undefined ? {} : { open_question }),
          ...(role_version === undefined ? {} : { role_version }),
          ...(role_current_version === undefined ? {} : { role_current_version }),
        };
      });
    },
  };
}
