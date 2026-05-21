import type { Database } from "bun:sqlite";
import parser from "cron-parser";
import type { RuntimeProvider } from "@clobber/runtime";
import {
  RoleTriggerSchema,
  triggerId,
  type Agent,
  type Role,
  type RoleTrigger,
  type Workspace,
} from "@clobber/shared";
import type { Clock, TimeoutHandle } from "./clock.ts";
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
  type DispatchDeps,
} from "./trigger-dispatch.ts";

export type AttachOutcome = SpawnPipelineSuccess | SpawnPipelineNoBundleError;
export type AttachSessionFn = (input: {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
}) => AttachOutcome;

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
  readonly attachSession: AttachSessionFn;
  readonly synthesizePrompt?: (trigger: RoleTrigger, payload: unknown) => string;
}

export interface FireWebhookResult {
  readonly dispatched: number;
}

export interface TriggerScheduler {
  start(): void;
  stop(): void;
  reloadRole(roleId: string): void;
  reloadAgent(agentId: string): void;
  fireWebhook(path: string, payload: unknown): FireWebhookResult;
}

interface ScheduledCron extends AgentBinding {
  readonly trigger: { kind: "cron"; expr: string };
  handle: TimeoutHandle | null;
}

interface ScheduledWebhook extends AgentBinding {
  readonly trigger: { kind: "webhook"; path: string };
}

const UNSUPPORTED_KINDS: ReadonlySet<RoleTrigger["kind"]> = new Set([
  "file-watch",
  "issue-assigned",
]);

const PAYLOAD_MAX_CHARS = 2000;

function defaultSynthesize(trigger: RoleTrigger, payload: unknown): string {
  if (trigger.kind === "cron") return `a cron fired: ${trigger.expr}`;
  if (trigger.kind === "file-watch") return `a file-watch fired: ${trigger.glob}`;
  if (trigger.kind === "webhook") {
    const head = `a webhook fired: ${trigger.path}`;
    if (payload === undefined) return head;
    const body = JSON.stringify(payload, null, 2).slice(0, PAYLOAD_MAX_CHARS);
    return `${head}\n\n${body}`;
  }
  return trigger.repo === undefined
    ? "an issue was assigned"
    : `an issue was assigned in ${trigger.repo}`;
}

export function createTriggerScheduler(
  deps: TriggerSchedulerDeps,
): TriggerScheduler {
  const synthesize =
    deps.synthesizePrompt === undefined
      ? defaultSynthesize
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
  const cronsByAgent = new Map<string, Set<ScheduledCron>>();
  const webhooksByAgent = new Map<string, Set<ScheduledWebhook>>();
  const webhooksByPath = new Map<string, Set<ScheduledWebhook>>();
  let started = false;

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

  function isStillTracked(entry: ScheduledCron): boolean {
    const set = cronsByAgent.get(entry.agentId);
    return set !== undefined && set.has(entry);
  }

  function scheduleNext(entry: ScheduledCron): void {
    const now = deps.clock.now();
    let nextAt: Date;
    try {
      const it = parser.parseExpression(entry.trigger.expr, {
        currentDate: now,
        tz: "UTC",
      });
      nextAt = it.next().toDate();
    } catch {
      return;
    }
    const delay = Math.max(0, nextAt.getTime() - now.getTime());
    entry.handle = deps.clock.setTimeout(() => {
      entry.handle = null;
      dispatchTrigger(dispatchDeps, entry, entry.trigger, undefined);
      if (started && isStillTracked(entry)) scheduleNext(entry);
    }, delay);
  }

  function clearAgent(agentId: string): void {
    const crons = cronsByAgent.get(agentId);
    if (crons !== undefined) {
      for (const entry of crons) {
        if (entry.handle !== null) deps.clock.clearTimeout(entry.handle);
      }
      cronsByAgent.delete(agentId);
    }
    const webhooks = webhooksByAgent.get(agentId);
    if (webhooks !== undefined) {
      for (const entry of webhooks) {
        const set = webhooksByPath.get(entry.trigger.path);
        if (set !== undefined) {
          set.delete(entry);
          if (set.size === 0) webhooksByPath.delete(entry.trigger.path);
        }
      }
      webhooksByAgent.delete(agentId);
    }
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
    const crons = new Set<ScheduledCron>();
    const webhooks = new Set<ScheduledWebhook>();
    for (const trigger of loaded.triggers) {
      const id = triggerId(trigger);
      if (disabledIds.has(id)) {
        recordDisabledTrigger(dispatchDeps, binding, trigger, id);
        continue;
      }
      if (trigger.kind === "cron") {
        crons.add({ ...binding, trigger, handle: null });
        continue;
      }
      if (trigger.kind === "webhook") {
        webhooks.add({ ...binding, trigger });
        continue;
      }
      if (UNSUPPORTED_KINDS.has(trigger.kind)) {
        recordUnsupportedTrigger(dispatchDeps, binding, trigger);
      }
    }
    if (crons.size > 0) {
      cronsByAgent.set(agentId, crons);
      for (const entry of crons) scheduleNext(entry);
    }
    if (webhooks.size > 0) {
      webhooksByAgent.set(agentId, webhooks);
      for (const entry of webhooks) {
        let set = webhooksByPath.get(entry.trigger.path);
        if (set === undefined) {
          set = new Set<ScheduledWebhook>();
          webhooksByPath.set(entry.trigger.path, set);
        }
        set.add(entry);
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
    for (const set of cronsByAgent.values()) {
      for (const entry of set) {
        if (entry.handle !== null) deps.clock.clearTimeout(entry.handle);
      }
    }
    cronsByAgent.clear();
    webhooksByAgent.clear();
    webhooksByPath.clear();
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

  function fireWebhook(path: string, payload: unknown): FireWebhookResult {
    const set = webhooksByPath.get(path);
    if (set === undefined) return { dispatched: 0 };
    let dispatched = 0;
    for (const entry of set) {
      if (dispatchTrigger(dispatchDeps, entry, entry.trigger, payload)) {
        dispatched += 1;
      }
    }
    return { dispatched };
  }

  return { start, stop, reloadRole, reloadAgent, fireWebhook };
}
