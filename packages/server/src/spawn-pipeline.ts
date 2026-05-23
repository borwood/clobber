import { randomUUID } from "node:crypto";
import type { RuntimeProvider } from "@clobber/runtime";
import type { Agent, BriefingPacket, Role, Workspace } from "@clobber/shared";
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
}

export interface SpawnPipelineInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly prompt: string;
  readonly label: string;
  readonly briefing?: BriefingPacket;
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
  const { workspace, role, prompt, label, briefing } = input;

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
  });
}

export interface AttachSessionInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
  readonly briefing?: BriefingPacket;
}

export async function attachSessionToAgent(
  deps: SpawnPipelineDeps,
  input: AttachSessionInput,
): Promise<SpawnPipelineSuccess | SpawnPipelineNoBundleError> {
  const { workspace, role, agent, prompt, briefing } = input;
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
    transcript_path: deps.runtimeProvider.transcriptPath(workspace.repo_path, sessionId),
  });
  bindLiveSession(deps, sessionId, ctx, spawned);

  return { ok: true, agent_id: agent.id, session_id: sessionId, pid: spawned.pid };
}

export async function resumeSessionTurn(
  deps: SpawnPipelineDeps,
  input: { readonly sessionId: string; readonly prompt: string },
): Promise<ResumeTurnSuccess | ResumeTurnError> {
  const session = deps.sessions.get(input.sessionId);
  if (session === null || session.ended_at !== undefined) {
    return { ok: false, status: 409, error: "runtime provider thread unavailable" };
  }
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
    prompt: input.prompt,
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
      endSession(sessionId, deps);
      return;
    }
    if (code !== 0 && code !== null) {
      endSession(sessionId, deps);
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
