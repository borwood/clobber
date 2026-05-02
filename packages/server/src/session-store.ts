import type { Database } from "bun:sqlite";
import { SessionSchema, type Session, type CreateSessionRequest } from "@clobber/shared";

export interface SessionStore {
  create(req: CreateSessionRequest): Session;
  get(id: string): Session | null;
  countActive(workspaceId: string, roleId: string): number;
  markEnded(id: string): boolean;
  updateTranscriptPath(id: string, path: string): boolean;
  listForWorkspace(workspaceId: string): Session[];
}

interface Row {
  id: string;
  agent_id: string | null;
  workspace_id: string;
  role_id: string;
  pid: number;
  started_at: number;
  ended_at: number | null;
  transcript_path: string | null;
}

function rowToSession(row: Row): Session {
  const input: Record<string, unknown> = {
    id: row.id,
    workspace_id: row.workspace_id,
    role_id: row.role_id,
    pid: row.pid,
    started_at: row.started_at,
  };
  if (row.agent_id !== null) input["agent_id"] = row.agent_id;
  if (row.ended_at !== null) input["ended_at"] = row.ended_at;
  if (row.transcript_path !== null) input["transcript_path"] = row.transcript_path;
  return SessionSchema.parse(input);
}

export function createSessionStore(db: Database): SessionStore {
  const insertStmt = db.prepare(
    `INSERT INTO sessions
       (id, agent_id, workspace_id, role_id, pid, started_at, ended_at, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const getStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const countActiveStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND role_id = ? AND ended_at IS NULL",
  );
  const markEndedStmt = db.prepare(
    "UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
  );
  const updateTranscriptStmt = db.prepare(
    "UPDATE sessions SET transcript_path = ? WHERE id = ?",
  );
  const listStmt = db.prepare(
    "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC, id DESC",
  );

  return {
    create(req) {
      const started_at = Date.now();
      const transcript_path =
        req.transcript_path === undefined ? null : req.transcript_path;
      insertStmt.run(
        req.id,
        req.agent_id,
        req.workspace_id,
        req.role_id,
        req.pid,
        started_at,
        transcript_path,
      );
      const out: Record<string, unknown> = {
        id: req.id,
        agent_id: req.agent_id,
        workspace_id: req.workspace_id,
        role_id: req.role_id,
        pid: req.pid,
        started_at,
      };
      if (req.transcript_path !== undefined) out["transcript_path"] = req.transcript_path;
      return SessionSchema.parse(out);
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToSession(row);
    },

    countActive(workspaceId, roleId) {
      const row = countActiveStmt.get(workspaceId, roleId) as { n: number };
      return row.n;
    },

    markEnded(id) {
      const result = markEndedStmt.run(Date.now(), id);
      return result.changes > 0;
    },

    updateTranscriptPath(id, path) {
      const result = updateTranscriptStmt.run(path, id);
      return result.changes > 0;
    },

    listForWorkspace(workspaceId) {
      const rows = listStmt.all(workspaceId) as Row[];
      return rows.map(rowToSession);
    },
  };
}
