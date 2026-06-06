import {
  RoleTriggerSchema,
  triggerId,
  type Agent,
  type RoleTrigger,
} from "@clobber/shared";
import { resolveCurrentRoleVersion } from "./resolve-role-content.ts";
import {
  dispatchTrigger,
  recordDisabledTrigger,
  recordUnsupportedTrigger,
  type AgentBinding,
  type DispatchDeps,
  type DispatchResult,
} from "./trigger-dispatch.ts";
import { createNotificationDispatcher } from "./notification-dispatch.ts";
import { createNotificationStore } from "./notification-store.ts";
import { defaultSynthesizePrompt } from "./trigger-synthesize.ts";
import {
  UNSUPPORTED_KINDS,
  DEFAULT_WORKSPACE_OPEN_DEBOUNCE_MS,
  type ScheduledWebhook,
  type ScheduledWorkspaceOpen,
  type TriggerSchedulerDeps,
  type TriggerScheduler,
} from "./trigger-scheduler-types.ts";
import { createCronScheduler } from "./trigger-cron-scheduler.ts";
import { createCompletionWakeSchedulers } from "./completion-wake-schedulers.ts";
import {
  addToKeyedIndex,
  clearAgentFromKeyedIndex,
} from "./trigger-keyed-index.ts";

// Re-export the public interfaces so callers importing from this module keep working.
export type { TriggerSchedulerDeps, TriggerScheduler } from "./trigger-scheduler-types.ts";

export function createTriggerScheduler(
  deps: TriggerSchedulerDeps,
): TriggerScheduler {
  const synthesize =
    deps.synthesizePrompt === undefined ? defaultSynthesizePrompt : deps.synthesizePrompt;
  const dispatcher =
    deps.dispatcher === undefined
      ? createNotificationDispatcher(createNotificationStore(deps.db), deps.clock)
      : deps.dispatcher;
  const dispatchDeps: DispatchDeps = {
    clock: deps.clock,
    agents: deps.agents,
    roles: deps.roles,
    workspaces: deps.workspaces,
    sessions: deps.sessions,
    registry: deps.registry,
    runtimeProvider: deps.runtimeProvider,
    dispatches: deps.dispatches,
    attachSession: deps.attachSession,
    resumeEndedSession: deps.resumeEndedSession,
    dispatcher,
    synthesize,
  };
  const webhooksByAgent = new Map<string, Set<ScheduledWebhook>>();
  const webhooksByPath = new Map<string, Set<ScheduledWebhook>>();
  const workspaceOpensByAgent = new Map<string, Set<ScheduledWorkspaceOpen>>();
  const workspaceOpensByWorkspace = new Map<string, Set<ScheduledWorkspaceOpen>>();
  let started = false;
  const cronScheduler = createCronScheduler(deps.clock, dispatchDeps, () => started);
  const completionWakes = createCompletionWakeSchedulers(
    { sessions: deps.sessions, agentStatusLog: deps.agentStatusLog },
    dispatchDeps,
  );

  function loadTriggersForAgent(
    agentId: string,
  ): { agent: Agent; triggers: RoleTrigger[] } | null {
    const agent = deps.agents.get(agentId);
    if (agent === null) return null;
    const role = deps.roles.get(agent.role_id);
    if (role === null || !role.persistent) return null;
    // #385 — resolve through the commit-pin view: a git-backed manager has no
    // `role_versions` row, so reading `current_version_id` directly would never
    // register its triggers and it would never wake.
    const version = resolveCurrentRoleVersion(role, deps);
    if (version === null) return null;
    const raw = JSON.parse(version.triggers_json) as unknown[];
    const triggers: RoleTrigger[] = [];
    for (const t of raw) {
      const parsed = RoleTriggerSchema.safeParse(t);
      if (parsed.success) triggers.push(parsed.data);
    }
    return { agent, triggers };
  }

  function clearAgent(agentId: string): void {
    cronScheduler.clearAgent(agentId);
    clearAgentFromKeyedIndex<ScheduledWebhook>(
      agentId,
      (e) => e.trigger.path,
      webhooksByAgent,
      webhooksByPath,
    );
    clearAgentFromKeyedIndex<ScheduledWorkspaceOpen>(
      agentId,
      (e) => e.workspaceId,
      workspaceOpensByAgent,
      workspaceOpensByWorkspace,
    );
    completionWakes.clearAgent(agentId);
  }

  function registerAgent(agentId: string): void {
    const loaded = loadTriggersForAgent(agentId);
    if (loaded === null) return;
    const binding: AgentBinding = {
      agentId: loaded.agent.id,
      roleId: loaded.agent.role_id,
      workspaceId: loaded.agent.workspace_id,
    };
    const workspace = deps.workspaces.get(loaded.agent.workspace_id);
    if (workspace === null) return;
    const override = workspace.trigger_overrides[loaded.agent.role_id];
    const disabledIds =
      override === undefined ? new Set<string>() : new Set(override.disabled_trigger_ids);
    for (const trigger of loaded.triggers) {
      const id = triggerId(trigger);
      if (disabledIds.has(id)) {
        recordDisabledTrigger(dispatchDeps, binding, trigger, id);
        continue;
      }
      if (trigger.kind === "cron") {
        cronScheduler.register({ ...binding, trigger, handle: null });
        continue;
      }
      if (trigger.kind === "webhook") {
        addToKeyedIndex(
          { ...binding, trigger },
          agentId,
          trigger.path,
          webhooksByAgent,
          webhooksByPath,
        );
        continue;
      }
      if (trigger.kind === "workspace-open") {
        const debounceMs =
          trigger.debounce_ms === undefined
            ? DEFAULT_WORKSPACE_OPEN_DEBOUNCE_MS
            : trigger.debounce_ms;
        addToKeyedIndex(
          { ...binding, trigger, debounceMs, lastFiredAt: null },
          agentId,
          binding.workspaceId,
          workspaceOpensByAgent,
          workspaceOpensByWorkspace,
        );
        continue;
      }
      if (trigger.kind === "session-ended") {
        completionWakes.registerSessionEnded({ ...binding, trigger });
        continue;
      }
      if (trigger.kind === "worker-done") {
        completionWakes.registerWorkerDone({ ...binding, trigger });
        continue;
      }
      if (UNSUPPORTED_KINDS.has(trigger.kind)) {
        recordUnsupportedTrigger(dispatchDeps, binding, trigger);
      }
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    const rows = deps.db
      .prepare(
        `SELECT a.id AS id
           FROM agents a
           INNER JOIN roles r ON r.id = a.role_id
           WHERE r.persistent = 1`,
      )
      .all() as Array<{ id: string }>;
    for (const row of rows) registerAgent(row.id);
  }

  function stop(): void {
    started = false;
    cronScheduler.clearAll();
    webhooksByAgent.clear();
    webhooksByPath.clear();
    workspaceOpensByAgent.clear();
    workspaceOpensByWorkspace.clear();
    completionWakes.clearAll();
  }

  function reloadAgent(agentId: string): void {
    clearAgent(agentId);
    if (started) registerAgent(agentId);
  }

  function reloadRole(roleId: string): void {
    const rows = deps.db
      .prepare("SELECT id FROM agents WHERE role_id = ?")
      .all(roleId) as Array<{ id: string }>;
    for (const r of rows) reloadAgent(r.id);
  }

  async function fireWebhook(
    path: string,
    payload: unknown,
  ): Promise<DispatchResult> {
    const set = webhooksByPath.get(path);
    if (set === undefined) return { dispatched: 0 };
    let dispatched = 0;
    for (const entry of set) {
      if (await dispatchTrigger(dispatchDeps, entry, entry.trigger, payload)) {
        dispatched += 1;
      }
    }
    return { dispatched };
  }

  async function fireWorkspaceOpen(
    workspaceId: string,
    payload: unknown,
  ): Promise<DispatchResult> {
    const set = workspaceOpensByWorkspace.get(workspaceId);
    if (set === undefined) return { dispatched: 0 };
    const now = deps.clock.now().getTime();
    let dispatched = 0;
    for (const entry of set) {
      if (
        entry.lastFiredAt !== null &&
        now - entry.lastFiredAt < entry.debounceMs
      ) {
        continue;
      }
      if (await dispatchTrigger(dispatchDeps, entry, entry.trigger, payload)) {
        entry.lastFiredAt = now;
        dispatched += 1;
      }
    }
    return { dispatched };
  }

  return {
    start,
    stop,
    reloadRole,
    reloadAgent,
    fireWebhook,
    fireWorkspaceOpen,
    fireSessionEnded: completionWakes.fireSessionEnded,
    fireWorkerDone: completionWakes.fireWorkerDone,
    flushPendingWakes: completionWakes.flushPendingWakes,
    drainCronDispatches: cronScheduler.drainInFlight,
  };
}
