import { randomUUID } from "node:crypto";
import type { RuntimeProvider } from "@clobber/runtime";
import type { Agent, BriefingPacket, EffortLevel, Role, Session, Workspace } from "@clobber/shared";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionTokenStore } from "./session-token-store.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "./types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";
import { endSession } from "./session-lifecycle.ts";
import { prepareSpawnContext, type SpawnContext } from "./spawn-context.ts";
import { bindRuntimeEvents } from "./runtime-event-binder.ts";
import { isProviderThreadMissing, waitForRuntimeStartup } from "./runtime-startup.ts";

export interface SpawnPipelineDeps {
  readonly workspaces: WorkspaceStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly sessionTokens: SessionTokenStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly registry: AgentRegistry;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly runtimeProvider: RuntimeProvider;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  // Fired once, on the reaper call that actually transitions a session to
  // ended, so a crash / non-zero exit (where no SessionEnd hook arrives) still
  // wakes a manager declaring a `session-ended` trigger. Injected late by the
  // server to break the spawn-pipeline ↔ scheduler construction cycle.
  readonly onSessionEnded: (workspaceId: string, finishedSessionId: string) => void;
}

export interface SpawnPipelineInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly prompt: string;
  readonly label: string;
  readonly briefing?: BriefingPacket;
  readonly effortOverride?: EffortLevel;
}

export interface SpawnPipelineSuccess {
  readonly ok: true;
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
}

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

export interface SpawnPipelineCapacityError {
  readonly ok: false;
  readonly status: 403;
  readonly error: "role at capacity";
  readonly ceiling: number;
  readonly active: number;
}

export interface SpawnPipelineNoBundleError {
  readonly ok: false;
  readonly status: 422;
  readonly error: "role has no current version";
  readonly role: string;
}

export type SpawnPipelineResult =
  | SpawnPipelineSuccess
  | SpawnPipelineCapacityError
  | SpawnPipelineNoBundleError;

export async function executeSpawn(
  deps: SpawnPipelineDeps,
  input: SpawnPipelineInput,
): Promise<SpawnPipelineResult> {
  const { workspace, role, prompt, label, briefing, effortOverride } = input;

  const capacity = checkCapacity(deps, workspace, role);
  if (capacity !== null) return capacity;

  const agent = deps.agents.create({
    workspace_id: workspace.id,
    role_id: role.id,
    label,
  });
  return attachSessionToAgent(deps, {
    workspace,
    role,
    agent,
    prompt,
    ...(briefing === undefined ? {} : { briefing }),
    ...(effortOverride === undefined ? {} : { effortOverride }),
  });
}

export interface AttachSessionInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
  readonly briefing?: BriefingPacket;
  readonly effortOverride?: EffortLevel;
}

export async function attachSessionToAgent(
  deps: SpawnPipelineDeps,
  input: AttachSessionInput,
): Promise<SpawnPipelineSuccess | SpawnPipelineNoBundleError> {
  const { workspace, role, agent, prompt, briefing, effortOverride } = input;
  const sessionId = randomUUID();
  const versionId = role.current_version_id;

  const prepared = await prepareSpawnContext(deps, {
    mode: "attach",
    workspace,
    role,
    agent,
    sessionId,
    versionId,
    prompt,
    ...(briefing === undefined ? {} : { briefing }),
    ...(effortOverride === undefined ? {} : { effortOverride }),
  });
  if (!prepared.ok) return prepared;
  const ctx = prepared.context;

  const spawnReq = deps.runtimeProvider.buildSpawnRequest(ctx.spawnOptions);
  const spawned = deps.spawner(spawnReq);
  const providerThreadId = deps.runtimeProvider.initialProviderThreadId(sessionId);

  deps.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: workspace.id,
    role_id: role.id,
    role_version_id: versionId,
    runtime_provider: deps.runtimeProvider.id,
    ...(providerThreadId === undefined ? {} : { provider_thread_id: providerThreadId }),
    // Denormalize the agent's label onto the session so the sidebar can
    // still show it after the agent row is deleted on non-persistent end.
    ...(agent.label === undefined ? {} : { label: agent.label }),
    pid: spawned.pid,
    // Derive from the resolved cwd, not repo_path: with spawn_worktree on the
    // session runs in a worktree, and the transcript lands under that slug.
    transcript_path: deps.runtimeProvider.transcriptPath(ctx.spawnOptions.cwd, sessionId),
  });
  bindLiveSession(deps, sessionId, ctx, spawned);

  return { ok: true, agent_id: agent.id, session_id: sessionId, pid: spawned.pid };
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
  input: { readonly sessionId: string; readonly prompt: string },
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
  prompt: string,
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
  bindLiveSession(deps, session.id, ctx, spawned);
  return { ok: true, session_id: session.id, pid: spawned.pid };
}

function bindLiveSession(
  deps: SpawnPipelineDeps,
  sessionId: string,
  ctx: SpawnContext,
  spawned: SpawnedAgentInfo,
): void {
  deps.sessionTokens.register(sessionId, ctx.token);
  deps.registry.register(sessionId, spawned.stdin, spawned.kill);
  bindRuntimeEvents(deps, sessionId, spawned);
  const endOnCleanExit = deps.runtimeProvider.capabilities.processLifetime === "session";
  spawned.exited.then((code) => {
    deps.registry.unregister(sessionId);
    if (endOnCleanExit) {
      const ended = endSession(sessionId, deps);
      if (ended !== null) deps.onSessionEnded(ended.workspaceId, ended.sessionId);
      return;
    }
    if (code !== 0 && code !== null) {
      const ended = endSession(sessionId, deps);
      if (ended !== null) deps.onSessionEnded(ended.workspaceId, ended.sessionId);
    }
  });
}

function checkCapacity(
  deps: SpawnPipelineDeps,
  workspace: Workspace,
  role: Role,
): SpawnPipelineCapacityError | null {
  const ceilingRow = deps.workspaceRoles.getCeiling(workspace.id, role.id);
  const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
  const active = deps.sessions.countActive(workspace.id, role.id);
  if (active >= ceiling) {
    return { ok: false, status: 403, error: "role at capacity", ceiling, active };
  }
  return null;
}
