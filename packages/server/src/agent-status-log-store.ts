import type { Database } from "bun:sqlite";
import { readLastMessageUuid, resolveGitProvenance } from "./audit-provenance-helpers.ts";

export type AgentStatusLogKind =
  | "status"
  | "phase-transition"
  | "task-snapshot"
  | "finding"
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
  readonly commit: string | null;
  readonly branch: string | null;
  readonly role_version_id: string | null;
  readonly role_commit_sha: string | null;
  readonly role_commit_branch: string | null;
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
  // findings and final-reports together for the triage reader (`clobber reports list`).
  listFindingsAndReportsForWorkspace(workspaceId: string): AgentStatusLogEntry[];
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
  commit: string | null;
  branch: string | null;
  role_version_id: string | null;
  role_commit_sha: string | null;
  role_commit_branch: string | null;
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
    commit: row.commit,
    branch: row.branch,
    role_version_id: row.role_version_id,
    role_commit_sha: row.role_commit_sha,
    role_commit_branch: row.role_commit_branch,
  };
}

interface SessionProvenanceRow {
  role_version_id: string | null;
  role_commit_sha: string | null;
  role_commit_branch: string | null;
  transcript_path: string | null;
  repo_path: string;
}

const DEFAULT_LIST_LIMIT = 100;

export function createAgentStatusLogStore(db: Database): AgentStatusLogStore {
  const insertStmt = db.prepare(`
    INSERT INTO agent_status_log
      (agent_id, session_id, event_id, kind, state, summary, details_json, created_at,
       "commit", branch, role_version_id, role_commit_sha, role_commit_branch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const findingsAndReportsForWorkspaceStmt = db.prepare(`
    SELECT log.* FROM agent_status_log log
    JOIN sessions s ON s.id = log.session_id
    WHERE log.kind IN ('finding', 'final-report') AND s.workspace_id = ?
    ORDER BY log.created_at DESC, log.id DESC
  `);
  const sessionProvenanceStmt = db.prepare(`
    SELECT s.role_version_id, s.role_commit_sha, s.role_commit_branch,
           s.transcript_path, w.repo_path
    FROM sessions s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = ?
  `);

  return {
    append(req) {
      const eventId = req.event_id === undefined ? null : req.event_id;

      // Resolve provenance from the session's workspace and transcript.
      // Best-effort: failures stamp null + reason rather than throwing (#221,
      // approved by Brennan — losing an audit row to preserve a stamp inverts
      // the priority).
      let commit: string | null = null;
      let branch: string | null = null;
      let roleVersionId: string | null = null;
      let roleCommitSha: string | null = null;
      let roleCommitBranch: string | null = null;
      let provenanceError: string | null = null;
      let transcriptAnchor: string | null = null;

      try {
        const prov = sessionProvenanceStmt.get(req.session_id) as SessionProvenanceRow | null;
        if (prov === null) {
          provenanceError = `session not found: ${req.session_id}`;
        } else {
          roleVersionId = prov.role_version_id;
          roleCommitSha = prov.role_commit_sha;
          roleCommitBranch = prov.role_commit_branch;

          const git = resolveGitProvenance(prov.repo_path);
          if (git === null) {
            provenanceError = `git rev-parse failed on: ${prov.repo_path}`;
          } else {
            commit = git.commit;
            branch = git.branch;
          }

          if (prov.transcript_path !== null) {
            transcriptAnchor = readLastMessageUuid(prov.transcript_path);
          }
        }
      } catch (err) {
        provenanceError = String(err);
      }

      // Merge transcript_anchor (and any error) into the caller's details.
      const callerDetails = req.details === undefined ? {} : req.details;
      const mergedDetails: Record<string, unknown> = { ...callerDetails };
      if (transcriptAnchor !== null) mergedDetails.transcript_anchor = transcriptAnchor;
      if (provenanceError !== null) mergedDetails.provenance_error = provenanceError;
      const hasDetails = Object.keys(mergedDetails).length > 0;
      const detailsJson = hasDetails ? JSON.stringify(mergedDetails) : null;

      const row = insertStmt.get(
        req.agent_id,
        req.session_id,
        eventId,
        req.kind,
        req.state,
        req.summary,
        detailsJson,
        Date.now(),
        commit,
        branch,
        roleVersionId,
        roleCommitSha,
        roleCommitBranch,
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

    listFindingsAndReportsForWorkspace(workspaceId) {
      const rows = findingsAndReportsForWorkspaceStmt.all(workspaceId) as Row[];
      return rows.map(rowToEntry);
    },
  };
}
