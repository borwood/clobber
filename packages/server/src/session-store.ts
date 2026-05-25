import type { Database } from "bun:sqlite";
import { SessionSchema, type Session, type CreateSessionRequest } from "@clobber/shared";

export interface SessionStore {
  create(req: CreateSessionRequest): Session;
  get(id: string): Session | null;
  countActive(workspaceId: string, roleId: string): number;
  markEnded(id: string): boolean;
  // Revive an ended session: clear ended_at and the was-live-at-shutdown flag
  // so the row counts as active again and drops out of the resume-candidate set.
  markActive(id: string): boolean;
  // Flag a session as live-at-shutdown (set at boot reconciliation).
  markWasLiveAtShutdown(id: string): boolean;
  updatePid(id: string, pid: number): boolean;
  updateProviderThreadId(id: string, providerThreadId: string): boolean;
  updateTranscriptPath(id: string, path: string): boolean;
  listForWorkspace(workspaceId: string): Session[];
  listActiveForWorkspace(workspaceId: string): Session[];
  listActive(): Session[];
}

interface Row {
  id: string;
  agent_id: string | null;
  workspace_id: string;
  role_id: string;
  role_version_id: string | null;
  runtime_provider: string;
  provider_thread_id: string | null;
  label: string | null;
  pid: number;
  started_at: number;
  ended_at: number | null;
  transcript_path: string | null;
  was_live_at_shutdown: number;
}

function rowToSession(row: Row): Session {
  const input: Record<string, unknown> = {
    id: row.id,
    workspace_id: row.workspace_id,
    role_id: row.role_id,
    runtime_provider: row.runtime_provider,
    pid: row.pid,
    started_at: row.started_at,
  };
  if (row.agent_id !== null) input["agent_id"] = row.agent_id;
  if (row.role_version_id !== null) input["role_version_id"] = row.role_version_id;
  if (row.provider_thread_id !== null) {
    input["provider_thread_id"] = row.provider_thread_id;
  }
  if (row.label !== null) input["label"] = row.label;
  if (row.ended_at !== null) input["ended_at"] = row.ended_at;
  if (row.transcript_path !== null) input["transcript_path"] = row.transcript_path;
  if (row.was_live_at_shutdown === 1) input["was_live_at_shutdown"] = true;
  return SessionSchema.parse(input);
}

export function createSessionStore(db: Database): SessionStore {
  const insertStmt = db.prepare(
    `INSERT INTO sessions
       (id, agent_id, workspace_id, role_id, role_version_id, runtime_provider, provider_thread_id, label, pid, started_at, ended_at, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const getStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const countActiveStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND role_id = ? AND ended_at IS NULL",
  );
  const markEndedStmt = db.prepare(
    "UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
  );
  const markActiveStmt = db.prepare(
    "UPDATE sessions SET ended_at = NULL, was_live_at_shutdown = 0 WHERE id = ?",
  );
  const markWasLiveStmt = db.prepare(
    "UPDATE sessions SET was_live_at_shutdown = 1 WHERE id = ?",
  );
  const updatePidStmt = db.prepare(
    "UPDATE sessions SET pid = ? WHERE id = ? AND ended_at IS NULL",
  );
  const updateProviderThreadIdStmt = db.prepare(
    "UPDATE sessions SET provider_thread_id = ? WHERE id = ? AND ended_at IS NULL",
  );
  const updateTranscriptStmt = db.prepare(
    "UPDATE sessions SET transcript_path = ? WHERE id = ?",
  );
  const listStmt = db.prepare(
    "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC, id DESC",
  );
  const listActiveForWorkspaceStmt = db.prepare(
    "SELECT * FROM sessions WHERE workspace_id = ? AND ended_at IS NULL ORDER BY started_at ASC, id ASC",
  );
  const listActiveStmt = db.prepare(
    "SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at ASC, id ASC",
  );

  return {
    create(req) {
      const started_at = Date.now();
      const role_version_id =
        req.role_version_id === undefined ? null : req.role_version_id;
      const runtime_provider =
        req.runtime_provider === undefined ? "claude" : req.runtime_provider;
      const provider_thread_id =
        req.provider_thread_id === undefined ? null : req.provider_thread_id;
      const label = req.label === undefined ? null : req.label;
      const transcript_path =
        req.transcript_path === undefined ? null : req.transcript_path;
      insertStmt.run(
        req.id,
        req.agent_id,
        req.workspace_id,
        req.role_id,
        role_version_id,
        runtime_provider,
        provider_thread_id,
        label,
        req.pid,
        started_at,
        transcript_path,
      );
      const out: Record<string, unknown> = {
        id: req.id,
        agent_id: req.agent_id,
        workspace_id: req.workspace_id,
        role_id: req.role_id,
        runtime_provider,
        pid: req.pid,
        started_at,
      };
      if (req.role_version_id !== undefined) out["role_version_id"] = req.role_version_id;
      if (req.provider_thread_id !== undefined) {
        out["provider_thread_id"] = req.provider_thread_id;
      }
      if (req.label !== undefined) out["label"] = req.label;
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

    markActive(id) {
      const result = markActiveStmt.run(id);
      return result.changes > 0;
    },

    markWasLiveAtShutdown(id) {
      const result = markWasLiveStmt.run(id);
      return result.changes > 0;
    },

    updatePid(id, pid) {
      const result = updatePidStmt.run(pid, id);
      return result.changes > 0;
    },

    updateProviderThreadId(id, providerThreadId) {
      const result = updateProviderThreadIdStmt.run(providerThreadId, id);
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

    listActiveForWorkspace(workspaceId) {
      const rows = listActiveForWorkspaceStmt.all(workspaceId) as Row[];
      return rows.map(rowToSession);
    },

    listActive() {
      const rows = listActiveStmt.all() as Row[];
      return rows.map(rowToSession);
    },
  };
}
