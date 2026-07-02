import { SessionSchema, type Session } from "@clobber/shared";

export interface Row {
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
  model_override: string | null;
  effort_override: string | null;
}

export function rowToSession(row: Row): Session {
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
  if (row.model_override !== null) input["model_override"] = row.model_override;
  if (row.effort_override !== null) input["effort_override"] = row.effort_override;
  return SessionSchema.parse(input);
}
