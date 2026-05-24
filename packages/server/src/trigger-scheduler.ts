import type { Database } from "bun:sqlite";
import type { RuntimeProvider } from "@clobber/runtime";
import {
  RoleTriggerSchema,
  triggerId,
  type Agent,
  type Role,
  type RoleTrigger,
  type Workspace,
} from "@clobber/shared";
import type { Clock } from "./clock.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { TriggerDispatchStore } from "./trigger-dispatch-store.ts";
import type {
  SpawnPipelineSuccess,
  SpawnPipelineNoBundleError,
} from "./spawn-pipeline.ts";
import {
  dispatchTrigger,
  recordDisabledTrigger,
  recordUnsupportedTrigger,
  type AgentBinding,
  type BusyPolicy,
  type DispatchDeps,
} from "./trigger-dispatch.ts";
import { defaultSynthesizePrompt } from "./trigger-synthesize.ts";
import { createCronScheduler } from "./trigger-cron-scheduler.ts";
import {
  addToKeyedIndex,
  clearAgentFromKeyedIndex,
} from "./trigger-keyed-index.ts";
import { createAgentWorkQueue } from "./agent-work-queue.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";
import type { SessionEndedItem, SessionEndedWakePayload } from "./session-ended-wake.ts";

export type AttachOutcome = SpawnPipelineSuccess | SpawnPipelineNoBundleError;
export type AttachSessionFn = (input: {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
}) => Promise<AttachOutcome>;

export interface TriggerSchedulerDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly registry: AgentRegistry;
  readonly runtimeProvider: RuntimeProvider;
  readonly dispatches: TriggerDispatchStore;
  readonly agentStatusLog: AgentStatusLogStore;
  readonly attachSession: AttachSessionFn;
  readonly synthesizePrompt?: (trigger: RoleTrigger, payload: unknown) => string;
}

export interface FireWebhookResult {
  readonly dispatched: number;
}

export interface FireWorkspaceOpenResult {
  readonly dispatched: number;
}

export interface FireSessionEndedResult {
  readonly dispatched: number;
}

export interface TriggerScheduler {
  start(): void;
  stop(): void;
  reloadRole(roleId: string): void;
  reloadAgent(agentId: string): void;
  fireWebhook(path: string, payload: unknown): Promise<FireWebhookResult>;
  fireWorkspaceOpen(workspaceId: string, payload: unknown): Promise<FireWorkspaceOpenResult>;
  // Fired from the reaper's callers when a session ends. Enumerates persistent
  // agents in the workspace declaring a `session-ended` trigger and wakes each
  // with the finished session's outcome (rebuilt from persistent state).
  fireSessionEnded(
    workspaceId: string,
    finishedSessionId: string,
  ): Promise<FireSessionEndedResult>;
  // Called on an agent's Stop (busy→idle): delivers any completion wakes that
  // were enqueued while it was busy, coalesced into one.
  flushPendingWakes(agentId: string): Promise<void>;
}

interface ScheduledWebhook extends AgentBinding {
  readonly trigger: { kind: "webhook"; path: string };
}

interface ScheduledWorkspaceOpen extends AgentBinding {
  readonly trigger: { kind: "workspace-open"; debounce_ms?: number | undefined };
  readonly debounceMs: number;
  lastFiredAt: number | null;
}

interface ScheduledSessionEnded extends AgentBinding {
  readonly trigger: { kind: "session-ended" };
}

const UNSUPPORTED_KINDS: ReadonlySet<RoleTrigger["kind"]> = new Set([
  "file-watch",
  "issue-assigned",
]);

const DEFAULT_WORKSPACE_OPEN_DEBOUNCE_MS = 10_000;

export function createTriggerScheduler(
  deps: TriggerSchedulerDeps,
): TriggerScheduler {
  const synthesize =
    deps.synthesizePrompt === undefined
      ? defaultSynthesizePrompt
      : deps.synthesizePrompt;
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
    synthesize,
  };
  const webhooksByAgent = new Map<string, Set<ScheduledWebhook>>();
  const webhooksByPath = new Map<string, Set<ScheduledWebhook>>();
  const workspaceOpensByAgent = new Map<string, Set<ScheduledWorkspaceOpen>>();
  const workspaceOpensByWorkspace = new Map<string, Set<ScheduledWorkspaceOpen>>();
  const sessionEndedByAgent = new Map<string, Set<ScheduledSessionEnded>>();
  const sessionEndedByWorkspace = new Map<string, Set<ScheduledSessionEnded>>();
  // Completion wakes that arrived while the target agent was busy, held per
  // agent until its next idle (the Stop hook → flushPendingWakes).
  const pendingWakes = createAgentWorkQueue<SessionEndedItem>();
  const enqueueWhileBusy: BusyPolicy = {
    kind: "enqueue",
    enqueue: (binding, _trigger, payload) => {
      for (const item of (payload as SessionEndedWakePayload).ended) {
        pendingWakes.enqueue(binding.agentId, item);
      }
    },
  };
  let started = false;
  const cronScheduler = createCronScheduler(deps.clock, dispatchDeps, () => started);

  function loadTriggersForAgent(
    agentId: string,
  ): { agent: Agent; triggers: RoleTrigger[] } | null {
    const agent = deps.agents.get(agentId);
    if (agent === null) return null;
    const role = deps.roles.get(agent.role_id);
    if (role === null || !role.persistent) return null;
    const versionId = role.current_version_id;
    if (versionId === undefined) return null;
    const version = deps.roleVersions.get(versionId);
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
    clearAgentFromKeyedIndex<ScheduledSessionEnded>(
      agentId,
      (e) => e.workspaceId,
      sessionEndedByAgent,
      sessionEndedByWorkspace,
    );
    pendingWakes.clear(agentId);
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
        addToKeyedIndex(
          { ...binding, trigger },
          agentId,
          binding.workspaceId,
          sessionEndedByAgent,
          sessionEndedByWorkspace,
        );
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
    sessionEndedByAgent.clear();
    sessionEndedByWorkspace.clear();
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
  ): Promise<FireWebhookResult> {
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
  ): Promise<FireWorkspaceOpenResult> {
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

  // Rebuild a completion item from persistent state. The ephemeral agent is
  // gone (reaped), but the session row and its final-report row survive — a
  // report present means a rich wake, absent means a bare crash/kill triage.
  function buildSessionEndedItem(finishedSessionId: string): SessionEndedItem | null {
    const session = deps.sessions.get(finishedSessionId);
    if (session === null) return null;
    const report = deps.agentStatusLog.latestForSession(finishedSessionId, "final-report");
    return {
      sessionId: finishedSessionId,
      label: session.label === undefined ? null : session.label,
      summary: report === null ? null : report.summary,
    };
  }

  async function fireSessionEnded(
    workspaceId: string,
    finishedSessionId: string,
  ): Promise<FireSessionEndedResult> {
    const set = sessionEndedByWorkspace.get(workspaceId);
    if (set === undefined) return { dispatched: 0 };
    const item = buildSessionEndedItem(finishedSessionId);
    if (item === null) return { dispatched: 0 };
    const payload: SessionEndedWakePayload = { ended: [item] };
    let dispatched = 0;
    for (const entry of set) {
      if (
        await dispatchTrigger(dispatchDeps, entry, entry.trigger, payload, enqueueWhileBusy)
      ) {
        dispatched += 1;
      }
    }
    return { dispatched };
  }

  async function flushPendingWakes(agentId: string): Promise<void> {
    const items = pendingWakes.drain(agentId);
    if (items.length === 0) return;
    const set = sessionEndedByAgent.get(agentId);
    if (set === undefined) return;
    const entry = set.values().next().value;
    if (entry === undefined) return;
    const payload: SessionEndedWakePayload = { ended: items };
    await dispatchTrigger(dispatchDeps, entry, entry.trigger, payload, enqueueWhileBusy);
  }

  return {
    start,
    stop,
    reloadRole,
    reloadAgent,
    fireWebhook,
    fireWorkspaceOpen,
    fireSessionEnded,
    flushPendingWakes,
  };
}
