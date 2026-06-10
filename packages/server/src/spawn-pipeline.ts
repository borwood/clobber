import { randomUUID } from "node:crypto";
import type { RuntimeProvider } from "@clobber/runtime";
import type { Agent, BriefingPacket, CliScope, ClobberPromptTag, EffortLevel, Model, Role, Workspace } from "@clobber/shared";
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
import type { NotificationStore } from "./notification-store.ts";
import { endSession } from "./session-lifecycle.ts";
import { prepareSpawnContext, type SpawnContext } from "./spawn-context.ts";
import { bindRuntimeEvents } from "./runtime-event-binder.ts";
import { embodyRole, rolePin } from "./embody-role.ts";
import type { RoleContentCache } from "./role-content-cache.ts";

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
  // #349 git-as-truth — present when the upstream role repo is materialized
  // (boot wires it). Embodiment reads commit-pinned roles through the cache;
  // a commit pin with these absent is a misconfiguration (embodyRole throws).
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  readonly runtimeProvider: RuntimeProvider;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  // Fired once, on the reaper call that actually transitions a session to
  // ended, so a crash / non-zero exit (where no SessionEnd hook arrives) still
  // wakes a manager declaring a `session-ended` trigger. Injected late by the
  // server to break the spawn-pipeline ↔ scheduler construction cycle.
  readonly onSessionEnded: (workspaceId: string, finishedSessionId: string) => void;
  // Phase-2 boot re-dump: un-acked notifications surface in the agent's system
  // prompt on every wake (persistent agents only, non-flushing).
  readonly notifications: NotificationStore;
}

export interface SpawnPipelineInput {
  readonly workspace: Workspace;
  readonly role: Role;
  // The caller's opening message. For the `custom` built-in this becomes the
  // kick; for named/default programs the wake-program's own kick takes over and
  // the prompt is unused. Absent = no kick (idle/boot-and-wait behavior).
  readonly prompt?: string;
  // Provenance for the caller's prompt. Defaults to `spawn-prompt` (the /spawn
  // route, briefing/`--prompt` path); trigger fires override to `trigger` with
  // the trigger-kind in `attrs.via`.
  readonly promptTag?: ClobberPromptTag;
  readonly label: string;
  // "default" resolves to the role's declared default_wake_program (same as
  // omitting the field). Named programs and built-ins ("idle", "custom", "cycle")
  // are passed through to resolveWakeProgram.
  readonly wakeProgram?: string;
  // Caller-supplied layer-C addon for the `custom` built-in (#501).
  readonly systemAddon?: string;
  readonly briefing?: BriefingPacket;
  readonly effortOverride?: EffortLevel;
  readonly modelOverride?: Model;
  readonly scopeOverride?: CliScope;
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

export interface SpawnPipelinePromptRequiredError {
  readonly ok: false;
  readonly status: 422;
  readonly error: "runtime requires a prompt";
}

export type SpawnPipelineResult =
  | SpawnPipelineSuccess
  | SpawnPipelineCapacityError
  | SpawnPipelineNoBundleError
  | SpawnPipelinePromptRequiredError;

export async function executeSpawn(
  deps: SpawnPipelineDeps,
  input: SpawnPipelineInput,
): Promise<SpawnPipelineResult> {
  const { workspace, role, prompt, label, briefing, effortOverride, modelOverride, scopeOverride, systemAddon } = input;
  const promptTag: ClobberPromptTag = input.promptTag ?? { kind: "spawn-prompt" };

  const capacity = checkCapacity(deps, workspace, role);
  if (capacity !== null) return capacity;

  // Surface 1 (#213): the spawn wake-program is a selector with a default. When
  // the caller selects nothing (undefined) OR explicitly sends "default", the
  // role's declared `default_wake_program` is its opening move (the worker's
  // `task`); a role that declares none falls through to idle. "default" is the
  // explicit selector the web composer sends (#501); legacy callers still use
  // undefined and get the same behavior.
  const wakeProgram = (input.wakeProgram === undefined || input.wakeProgram === "default")
    ? defaultWakeProgramFor(deps, role)
    : input.wakeProgram;

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
    ...(systemAddon === undefined ? {} : { systemAddon }),
    ...(briefing === undefined ? {} : { briefing }),
    ...(effortOverride === undefined ? {} : { effortOverride }),
    ...(modelOverride === undefined ? {} : { modelOverride }),
    ...(scopeOverride === undefined ? {} : { scopeOverride }),
  });
}

// A role's declared default opening move for a fresh spawn, or undefined (→
// idle) when it declares none.
function defaultWakeProgramFor(deps: SpawnPipelineDeps, role: Role): string | undefined {
  const bundle = embodyRole(role, rolePin(role), deps);
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
  // Caller-supplied layer-C addon for the `custom` built-in (#501).
  readonly systemAddon?: string;
  // Op-level system addon from the triggering operation (#502). Absent for
  // plain spawn; cycle supplies the orientation text.
  readonly opLevelAddon?: string;
  readonly briefing?: BriefingPacket;
  readonly effortOverride?: EffortLevel;
  readonly modelOverride?: Model;
  readonly scopeOverride?: CliScope;
}

export async function attachSessionToAgent(
  deps: SpawnPipelineDeps,
  input: AttachSessionInput,
): Promise<SpawnPipelineSuccess | SpawnPipelineNoBundleError | SpawnPipelinePromptRequiredError> {
  const { workspace, role, agent, prompt, promptTag, wakeProgram, systemAddon, opLevelAddon, briefing, effortOverride, modelOverride, scopeOverride } = input;
  const sessionId = randomUUID();
  const pin = rolePin(role);

  const prepared = await prepareSpawnContext(deps, {
    mode: "attach",
    workspace,
    role,
    agent,
    sessionId,
    pin,
    prompt,
    ...(promptTag === undefined ? {} : { promptTag }),
    ...(wakeProgram === undefined ? {} : { wakeProgram }),
    ...(systemAddon === undefined ? {} : { systemAddon }),
    ...(opLevelAddon === undefined ? {} : { opLevelAddon }),
    ...(briefing === undefined ? {} : { briefing }),
    ...(effortOverride === undefined ? {} : { effortOverride }),
    ...(modelOverride === undefined ? {} : { modelOverride }),
    ...(scopeOverride === undefined ? {} : { scopeOverride }),
  });
  if (!prepared.ok) return prepared;
  const ctx = prepared.context;

  if (deps.runtimeProvider.capabilities.requiresPrompt && ctx.spawnOptions.prompt === undefined) {
    return { ok: false, status: 422, error: "runtime requires a prompt" };
  }

  const spawnReq = deps.runtimeProvider.buildSpawnRequest(ctx.spawnOptions);
  const spawned = deps.spawner(spawnReq);
  const providerThreadId = deps.runtimeProvider.initialProviderThreadId(sessionId);

  deps.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: workspace.id,
    role_id: role.id,
    // Capture the embodied commit pin so resume re-resolves the SAME content (#349).
    ...(pin !== null ? { role_commit: { branch: pin.branch, sha: pin.sha } } : {}),
    runtime_provider: deps.runtimeProvider.id,
    ...(providerThreadId === undefined ? {} : { provider_thread_id: providerThreadId }),
    // Persist the opening move so resume re-composes the same layer-C addon.
    ...(wakeProgram === undefined ? {} : { wake_program: wakeProgram }),
    // Persist the op-level addon so resume re-composes the same orientation (#502).
    ...(opLevelAddon === undefined ? {} : { op_level_addon: opLevelAddon }),
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
    // Capture the resolved model/effort so the header shows actuals, not role
    // defaults that can differ under per-dispatch overrides (#468).
    ...(ctx.spawnOptions.model === undefined ? {} : { model: ctx.spawnOptions.model }),
    ...(ctx.spawnOptions.effort === undefined ? {} : { effort: ctx.spawnOptions.effort }),
  });
  bindLiveSession(deps, sessionId, ctx, spawned, ctx.spawnOptions.prompt !== undefined);

  return { ok: true, agent_id: agent.id, session_id: sessionId, pid: spawned.pid };
}

export function bindLiveSession(
  deps: SpawnPipelineDeps,
  sessionId: string,
  ctx: SpawnContext,
  spawned: SpawnedAgentInfo,
  busy: boolean,
): void {
  deps.sessionTokens.register(sessionId, ctx.token, ctx.scope_json);
  deps.registry.register(sessionId, spawned.stdin, spawned.kill, busy);
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
  excludeSessionId?: string,
): SpawnPipelineCapacityError | null {
  const ceilingRow = deps.workspaceRoles.getCeiling(workspace.id, role.id);
  const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
  const active = excludeSessionId !== undefined
    ? deps.sessions.countActiveExcluding(workspace.id, role.id, excludeSessionId)
    : deps.sessions.countActive(workspace.id, role.id);
  if (active >= ceiling) {
    return { ok: false, status: 403, error: "role at capacity", ceiling, active };
  }
  return null;
}
