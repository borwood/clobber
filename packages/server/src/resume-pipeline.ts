import type { Session } from "@clobber/shared";
import type { SpawnedAgentInfo } from "./types.ts";
import { endSession } from "./session-lifecycle.ts";
import { prepareSpawnContext } from "./spawn-context.ts";
import { isProviderThreadMissing, waitForRuntimeStartup } from "./runtime-startup.ts";
import {
  bindLiveSession,
  checkCapacity,
  type SpawnPipelineCapacityError,
  type SpawnPipelineDeps,
} from "./spawn-pipeline.ts";

export interface ResumeTurnSuccess {
  readonly ok: true;
  readonly session_id: string;
  readonly pid: number;
}

export interface ResumeTurnError {
  readonly ok: false;
  readonly status: 409 | 410 | 422 | 502;
  readonly error:
    | "runtime does not support resume"
    | "runtime provider thread unavailable"
    | "runtime provider thread not found"
    | "workspace not found"
    | "role not found"
    | "agent not found"
    | "role has no current version"
    | "runtime resume failed";
  readonly detail?: string;
}

export interface ResumeNotFoundError {
  readonly ok: false;
  readonly status: 404;
  readonly error: "session not found";
}

export interface ResumeStillActiveError {
  readonly ok: false;
  readonly status: 409;
  readonly error: "session is still active";
}

export type ResumeEndedResult =
  | ResumeTurnSuccess
  | ResumeTurnError
  | SpawnPipelineCapacityError
  | ResumeNotFoundError
  | ResumeStillActiveError;

/**
 * Continue an already-live turn-lifetime session (the wake / `/sessions/:id/prompt`
 * path). Rejects ended rows — reviving those is `resumeEndedSession`.
 */
export async function resumeSessionTurn(
  deps: SpawnPipelineDeps,
  input: { readonly sessionId: string; readonly prompt: string },
): Promise<ResumeTurnSuccess | ResumeTurnError> {
  const session = deps.sessions.get(input.sessionId);
  if (session === null || session.ended_at !== undefined) {
    return { ok: false, status: 409, error: "runtime provider thread unavailable" };
  }
  return performResume(deps, session, input.prompt);
}

/**
 * Revive an ended session (`clobber resume` / the UI resume button). Re-checks
 * the workspace role ceiling (mirrors spawn's 403) before re-occupying a slot,
 * then resumes the pinned role version against the same agent — so the worker
 * comes back with its original skills, worktree, and desk.
 */
export async function resumeEndedSession(
  deps: SpawnPipelineDeps,
  input: { readonly sessionId: string; readonly prompt: string | undefined },
): Promise<ResumeEndedResult> {
  const session = deps.sessions.get(input.sessionId);
  if (session === null) return { ok: false, status: 404, error: "session not found" };
  if (session.ended_at === undefined) {
    return { ok: false, status: 409, error: "session is still active" };
  }
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) return { ok: false, status: 422, error: "workspace not found" };
  const role = deps.roles.get(session.role_id);
  if (role === null) return { ok: false, status: 422, error: "role not found" };
  const capacity = checkCapacity(deps, workspace, role);
  if (capacity !== null) return capacity;
  return performResume(deps, session, input.prompt);
}

/**
 * Shared resume mechanic for both the live-continuation and revive-ended paths:
 * resolve the pinned context, respawn the runtime against the existing provider
 * thread, and re-register the live handles. `markActive` clears `ended_at` + the
 * was-live flag so a revived row counts as active again (a no-op for a row that
 * was already live).
 */
async function performResume(
  deps: SpawnPipelineDeps,
  session: Session,
  prompt: string | undefined,
): Promise<ResumeTurnSuccess | ResumeTurnError> {
  if (!deps.runtimeProvider.capabilities.resume || deps.runtimeProvider.buildResumeRequest === undefined) {
    return { ok: false, status: 409, error: "runtime does not support resume" };
  }
  const providerThreadId = session.provider_thread_id;
  if (providerThreadId === undefined) {
    return { ok: false, status: 409, error: "runtime provider thread unavailable" };
  }
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) return { ok: false, status: 422, error: "workspace not found" };
  const role = deps.roles.get(session.role_id);
  if (role === null) return { ok: false, status: 422, error: "role not found" };
  const agent = session.agent_id === undefined ? null : deps.agents.get(session.agent_id);
  if (agent === null) return { ok: false, status: 422, error: "agent not found" };

  const prepared = await prepareSpawnContext(deps, {
    mode: "resume",
    workspace,
    role,
    agent,
    sessionId: session.id,
    versionId: session.role_version_id ?? role.current_version_id,
    prompt,
    // Re-compose the original opening move's layer C; the kick stays suppressed
    // because prepareSpawnContext gates it on mode === "resume".
    ...(session.wake_program === undefined ? {} : { wakeProgram: session.wake_program }),
  });
  if (!prepared.ok) return prepared;
  const ctx = prepared.context;

  const spawnReq = deps.runtimeProvider.buildResumeRequest({
    ...ctx.spawnOptions,
    providerThreadId,
  });

  let spawned: SpawnedAgentInfo;
  try {
    spawned = deps.spawner(spawnReq);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isProviderThreadMissing(detail)) {
      endSession(session.id, deps);
      return { ok: false, status: 410, error: "runtime provider thread not found", detail };
    }
    return { ok: false, status: 502, error: "runtime resume failed", detail };
  }

  const startup = await waitForRuntimeStartup(spawned);
  if (!startup.ok) {
    if (isProviderThreadMissing(startup.detail)) {
      endSession(session.id, deps);
      return {
        ok: false,
        status: 410,
        error: "runtime provider thread not found",
        detail: startup.detail,
      };
    }
    return { ok: false, status: 502, error: "runtime resume failed", detail: startup.detail };
  }

  deps.sessions.markActive(session.id);
  deps.sessions.updatePid(session.id, spawned.pid);
  // The prompt is re-composed every wake; keep the row honest about the
  // rendered prompt this resume actually ran with (#253).
  deps.sessions.updateComposedSystemPrompt(session.id, ctx.spawnOptions.systemPrompt);
  bindLiveSession(deps, session.id, ctx, spawned);
  return { ok: true, session_id: session.id, pid: spawned.pid };
}
