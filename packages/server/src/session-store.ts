import type { Database } from "bun:sqlite";
import { SessionSchema, type Session, type CreateSessionRequest } from "@clobber/shared";

export interface SessionStore {
  create(req: CreateSessionRequest): Session;
  get(id: string): Session | null;
  // The agent's most recent session, ended or live. The messaging primitive
  // resolves a recipient agent to its current session; an ended one still
  // resolves (so the sender gets a 410, not a 404, for a recipient that died).
  latestForAgent(agentId: string): Session | null;
  // The agent's most recently ended session — used by the cycle supervisor to
  // find the right recovery target when zero live sessions are detected.
  latestEndedForAgent(agentId: string): Session | null;
  countActive(workspaceId: string, roleId: string): number;
  // Count active sessions for a workspace+role, excluding one specific session.
  // Used by the cycle ceiling-exemption: the kill-target is in-flight and must
  // not block the replacement's capacity check.
  countActiveExcluding(workspaceId: string, roleId: string, excludeSessionId: string): number;
  markEnded(id: string): boolean;
  // Revive an ended session: clear ended_at and the was-live-at-shutdown flag
  // so the row counts as active again and drops out of the resume-candidate set.
  markActive(id: string): boolean;
  // Flag a session as live-at-shutdown (set at boot reconciliation).
  markWasLiveAtShutdown(id: string): boolean;
  updatePid(id: string, pid: number): boolean;
  // Re-capture the composed prompt on resume so the row reflects the latest
  // wake's rendered `appendSystemPrompt` (#253).
  updateComposedSystemPrompt(id: string, prompt: string): boolean;
  // Re-capture the resolved model/effort on resume (#468).
  updateModelEffort(id: string, model: string | undefined, effort: string | undefined): boolean;
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
  role_commit_branch: string | null;
  role_commit_sha: string | null;
  runtime_provider: string;
  provider_thread_id: string | null;
  wake_program: string | null;
  op_level_addon: string | null;
  label: string | null;
  pid: number;
  started_at: number;
  ended_at: number | null;
  transcript_path: string | null;
  was_live_at_shutdown: number;
  composed_system_prompt: string | null;
  model: string | null;
  effort: string | null;
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
  if (row.role_commit_branch !== null && row.role_commit_sha !== null) {
    input["role_commit"] = { branch: row.role_commit_branch, sha: row.role_commit_sha };
  }
  if (row.provider_thread_id !== null) {
    input["provider_thread_id"] = row.provider_thread_id;
  }
  if (row.wake_program !== null) input["wake_program"] = row.wake_program;
  if (row.op_level_addon !== null) input["op_level_addon"] = row.op_level_addon;
  if (row.label !== null) input["label"] = row.label;
  if (row.ended_at !== null) input["ended_at"] = row.ended_at;
  if (row.transcript_path !== null) input["transcript_path"] = row.transcript_path;
  if (row.was_live_at_shutdown === 1) input["was_live_at_shutdown"] = true;
  if (row.composed_system_prompt !== null) {
    input["composed_system_prompt"] = row.composed_system_prompt;
  }
  if (row.model !== null) input["model"] = row.model;
  if (row.effort !== null) input["effort"] = row.effort;
  return SessionSchema.parse(input);
}

export function createSessionStore(db: Database): SessionStore {
  const insertStmt = db.prepare(
    `INSERT INTO sessions
       (id, agent_id, workspace_id, role_id, role_commit_branch, role_commit_sha, runtime_provider, provider_thread_id, wake_program, op_level_addon, label, pid, started_at, ended_at, transcript_path, composed_system_prompt, model, effort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const latestForAgentStmt = db.prepare(
    "SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
  );
  const latestEndedForAgentStmt = db.prepare(
    "SELECT * FROM sessions WHERE agent_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC LIMIT 1",
  );
  const countActiveStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND role_id = ? AND ended_at IS NULL",
  );
  const countActiveExcludingStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND role_id = ? AND ended_at IS NULL AND id != ?",
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
  const updateComposedPromptStmt = db.prepare(
    "UPDATE sessions SET composed_system_prompt = ? WHERE id = ?",
  );
  const updateModelEffortStmt = db.prepare(
    "UPDATE sessions SET model = ?, effort = ? WHERE id = ?",
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
      const role_commit_branch =
        req.role_commit === undefined ? null : req.role_commit.branch;
      const role_commit_sha =
        req.role_commit === undefined ? null : req.role_commit.sha;
      const runtime_provider =
        req.runtime_provider === undefined ? "claude" : req.runtime_provider;
      const provider_thread_id =
        req.provider_thread_id === undefined ? null : req.provider_thread_id;
      const wake_program = req.wake_program === undefined ? null : req.wake_program;
      const op_level_addon = req.op_level_addon === undefined ? null : req.op_level_addon;
      const label = req.label === undefined ? null : req.label;
      const transcript_path =
        req.transcript_path === undefined ? null : req.transcript_path;
      const composed_system_prompt =
        req.composed_system_prompt === undefined ? null : req.composed_system_prompt;
      const model = req.model === undefined ? null : req.model;
      const effort = req.effort === undefined ? null : req.effort;
      insertStmt.run(
        req.id,
        req.agent_id,
        req.workspace_id,
        req.role_id,
        role_commit_branch,
        role_commit_sha,
        runtime_provider,
        provider_thread_id,
        wake_program,
        op_level_addon,
        label,
        req.pid,
        started_at,
        transcript_path,
        composed_system_prompt,
        model,
        effort,
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
      if (req.role_commit !== undefined) out["role_commit"] = req.role_commit;
      if (req.provider_thread_id !== undefined) {
        out["provider_thread_id"] = req.provider_thread_id;
      }
      if (req.wake_program !== undefined) out["wake_program"] = req.wake_program;
      if (req.op_level_addon !== undefined) out["op_level_addon"] = req.op_level_addon;
      if (req.label !== undefined) out["label"] = req.label;
      if (req.transcript_path !== undefined) out["transcript_path"] = req.transcript_path;
      if (req.composed_system_prompt !== undefined) {
        out["composed_system_prompt"] = req.composed_system_prompt;
      }
      if (req.model !== undefined) out["model"] = req.model;
      if (req.effort !== undefined) out["effort"] = req.effort;
      return SessionSchema.parse(out);
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToSession(row);
    },

    latestForAgent(agentId) {
      const row = latestForAgentStmt.get(agentId) as Row | null;
      return row === null ? null : rowToSession(row);
    },

    latestEndedForAgent(agentId) {
      const row = latestEndedForAgentStmt.get(agentId) as Row | null;
      return row === null ? null : rowToSession(row);
    },

    countActive(workspaceId, roleId) {
      const row = countActiveStmt.get(workspaceId, roleId) as { n: number };
      return row.n;
    },

    countActiveExcluding(workspaceId, roleId, excludeSessionId) {
      const row = countActiveExcludingStmt.get(workspaceId, roleId, excludeSessionId) as { n: number };
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

    updateComposedSystemPrompt(id, prompt) {
      const result = updateComposedPromptStmt.run(prompt, id);
      return result.changes > 0;
    },

    updateModelEffort(id, model, effort) {
      const result = updateModelEffortStmt.run(
        model === undefined ? null : model,
        effort === undefined ? null : effort,
        id,
      );
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
