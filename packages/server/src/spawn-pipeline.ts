import { randomUUID } from "node:crypto";
import type { Agent, BriefingPacket, CliScope, ClobberPromptTag, EffortLevel, Model, Role, Workspace } from "@clobber/shared";
import type { SpawnedAgentInfo } from "./types.ts";
import { endSession } from "./session-lifecycle.ts";
import { prepareSpawnContext, type SpawnContext, type PrepareSpawnContextResult } from "./spawn-context.ts";
import { bindRuntimeEvents } from "./runtime-event-binder.ts";
import { WorktreeError } from "./spawn-worktree.ts";
import { embodyRole, rolePin } from "./embody-role.ts";
import { checkAgentRowCapacity, findReusableSessionlessAgent } from "./persistent-agent-reuse.ts";
export type { SpawnPipelineDeps } from "./spawn-pipeline-deps.ts";
import type { SpawnPipelineDeps } from "./spawn-pipeline-deps.ts";

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
  // The agent spawning this worker — recorded on the new agent row as the
  // capability-holder / owner for confirm-resume flows (#621).
  readonly spawnerAgentId?: string;
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
export interface SpawnPipelineWorktreeError {
  readonly ok: false; readonly status: 409 | 422 | 503; readonly error: "worktree-collision" | "worktree-fetch-failed" | "worktree-install-failed";
  readonly branch: string; readonly path: string; readonly stderr: string;
}
export type SpawnPipelineResult =
  | SpawnPipelineSuccess
  | SpawnPipelineCapacityError
  | SpawnPipelineNoBundleError
  | SpawnPipelinePromptRequiredError
  | SpawnPipelineWorktreeError;

export async function executeSpawn(
  deps: SpawnPipelineDeps,
  input: SpawnPipelineInput,
): Promise<SpawnPipelineResult> {
  const { workspace, role, prompt, label, briefing, effortOverride, modelOverride, scopeOverride, systemAddon } = input;
  const promptTag: ClobberPromptTag = input.promptTag ?? { kind: "spawn-prompt" };

  // Surface 1 (#213): the spawn wake-program is a selector with a default. When
  // the caller selects nothing (undefined) OR explicitly sends "default", the
  // role's declared `default_wake_program` is its opening move (the worker's
  // `task`); a role that declares none falls through to idle. "default" is the
  // explicit selector the web composer sends (#501); legacy callers still use
  // undefined and get the same behavior.
  const wakeProgram = (input.wakeProgram === undefined || input.wakeProgram === "default")
    ? defaultWakeProgramFor(deps, role)
    : input.wakeProgram;

  // A persistent role's identity is the agent row, not the session (#698
  // review): a session-less existing agent (established at workspace-create,
  // or left behind by an ended session) reuses its own identity rather than
  // minting a second one — a second agent row for an already-singleton role
  // would double-register the role's triggers. checkCapacity's active-session
  // count can't see a session-less agent, so persistent roles route through
  // the agent-row-based capacity check instead.
  if (role.persistent) {
    const reusable = findReusableSessionlessAgent(deps, workspace, role);
    if (reusable !== null) {
      // Reusing the identity should not silently drop the caller's requested
      // label — a fresh spawn would have carried it onto the new agent row.
      if (reusable.label !== label) deps.agents.updateLabel(reusable.id, label);
      return attachSessionToAgent(deps, {
        workspace,
        role,
        agent: { ...reusable, label },
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
    const agentCapacity = checkAgentRowCapacity(deps, workspace, role);
    if (agentCapacity !== null) return agentCapacity;
  } else {
    const capacity = checkCapacity(deps, workspace, role);
    if (capacity !== null) return capacity;
  }

  const agent = deps.agents.create({
    workspace_id: workspace.id,
    role_id: role.id,
    label,
    ...(input.spawnerAgentId === undefined ? {} : { spawner_agent_id: input.spawnerAgentId }),
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
): Promise<SpawnPipelineSuccess | SpawnPipelineNoBundleError | SpawnPipelinePromptRequiredError | SpawnPipelineWorktreeError> {
  const { workspace, role, agent, prompt, promptTag, wakeProgram, systemAddon, opLevelAddon, briefing, effortOverride, modelOverride, scopeOverride } = input;
  const sessionId = randomUUID();
  const pin = rolePin(role);

  let prepared: PrepareSpawnContextResult;
  try {
    prepared = await prepareSpawnContext(deps, {
      mode: "attach",
      workspace, role, agent, sessionId, pin, prompt,
      ...(promptTag === undefined ? {} : { promptTag }),
      ...(wakeProgram === undefined ? {} : { wakeProgram }),
      ...(systemAddon === undefined ? {} : { systemAddon }),
      ...(opLevelAddon === undefined ? {} : { opLevelAddon }),
      ...(briefing === undefined ? {} : { briefing }),
      ...(effortOverride === undefined ? {} : { effortOverride }),
      ...(modelOverride === undefined ? {} : { modelOverride }),
      ...(scopeOverride === undefined ? {} : { scopeOverride }),
    });
  } catch (err) {
    if (!(err instanceof WorktreeError)) throw err;
    return { ok: false,
      status: err.kind === "collision" ? 409 : err.kind === "fetch-failed" ? 503 : 422,
      error: err.kind === "collision" ? "worktree-collision" : err.kind === "fetch-failed" ? "worktree-fetch-failed" : "worktree-install-failed",
      branch: err.branch, path: err.path, stderr: err.stderr };
  }
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
    // Record explicit dials as facts so resume re-applies them instead of
    // silently reverting to role defaults.
    ...(modelOverride === undefined ? {} : { model_override: modelOverride }),
    ...(effortOverride === undefined ? {} : { effort_override: effortOverride }),
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
