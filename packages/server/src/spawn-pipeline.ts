import { randomUUID } from "node:crypto";
import type { RuntimeProvider } from "@clobber/runtime";
import type { Agent, BriefingPacket, ClobberPromptTag, EffortLevel, Role, Workspace } from "@clobber/shared";
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
  // Provenance for the caller's prompt. Defaults to `spawn-prompt` (the /spawn
  // route, briefing/`--prompt` path); trigger fires override to `trigger` with
  // the trigger-kind in `attrs.via`.
  readonly promptTag?: ClobberPromptTag;
  readonly label: string;
  readonly wakeProgram?: string;
  readonly briefing?: BriefingPacket;
  readonly effortOverride?: EffortLevel;
}

export interface SpawnPipelineSuccess {
  readonly ok: true;
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
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
  const promptTag: ClobberPromptTag = input.promptTag ?? { kind: "spawn-prompt" };

  const capacity = checkCapacity(deps, workspace, role);
  if (capacity !== null) return capacity;

  // Surface 1 (#213): the spawn wake-program is a selector with a default. When
  // the caller selects nothing, the role's declared `default_wake_program` is
  // its opening move (the worker's `task`); a role that declares none falls
  // through to idle (the manager — so #215's idle-default is already in place
  // for spawns, and only the trigger/office surfaces remain for it to flip).
  const wakeProgram = input.wakeProgram ?? defaultWakeProgramFor(deps, role);

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
    promptTag,
    ...(wakeProgram === undefined ? {} : { wakeProgram }),
    ...(briefing === undefined ? {} : { briefing }),
    ...(effortOverride === undefined ? {} : { effortOverride }),
  });
}

// A role's declared default opening move for a fresh spawn, or undefined (→
// idle) when it declares none.
function defaultWakeProgramFor(deps: SpawnPipelineDeps, role: Role): string | undefined {
  if (role.current_version_id === undefined) return undefined;
  const bundle = deps.roleVersions.loadAsBundle(role.current_version_id);
  if (bundle === null) return undefined;
  return bundle.defaultWakeProgram;
}

export interface AttachSessionInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  // Absent on a no-task wake — no opening user message to compose.
  readonly prompt: string | undefined;
  readonly promptTag?: ClobberPromptTag;
  readonly wakeProgram?: string;
  readonly briefing?: BriefingPacket;
  readonly effortOverride?: EffortLevel;
}

export async function attachSessionToAgent(
  deps: SpawnPipelineDeps,
  input: AttachSessionInput,
): Promise<SpawnPipelineSuccess | SpawnPipelineNoBundleError> {
  const { workspace, role, agent, prompt, promptTag, wakeProgram, briefing, effortOverride } = input;
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
    ...(promptTag === undefined ? {} : { promptTag }),
    ...(wakeProgram === undefined ? {} : { wakeProgram }),
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
    // Persist the opening move so resume re-composes the same layer-C addon.
    ...(wakeProgram === undefined ? {} : { wake_program: wakeProgram }),
    // Denormalize the agent's label onto the session so the sidebar can
    // still show it after the agent row is deleted on non-persistent end.
    ...(agent.label === undefined ? {} : { label: agent.label }),
    pid: spawned.pid,
    // Derive from the resolved cwd, not repo_path: with spawn_worktree on the
    // session runs in a worktree, and the transcript lands under that slug.
    transcript_path: deps.runtimeProvider.transcriptPath(ctx.spawnOptions.cwd, sessionId),
    // Capture the rendered prompt this wake was spawned with so the transcript
    // can surface exactly what the agent was told (#253).
    composed_system_prompt: ctx.spawnOptions.systemPrompt,
  });
  bindLiveSession(deps, sessionId, ctx, spawned);

  return { ok: true, agent_id: agent.id, session_id: sessionId, pid: spawned.pid };
}

export function bindLiveSession(
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

export function checkCapacity(
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
