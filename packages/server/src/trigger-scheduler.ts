import type { Database } from "bun:sqlite";
import parser from "cron-parser";
import { serializeUserMessage } from "@clobber/runtime";
import {
  RoleTriggerSchema,
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
import type { TriggerDispatchStore, DispatchOutcome } from "./trigger-dispatch-store.ts";
import type {
  SpawnPipelineSuccess,
  SpawnPipelineNoBundleError,
} from "./spawn-pipeline.ts";

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
  readonly dispatches: TriggerDispatchStore;
  readonly attachSession: AttachSessionFn;
  readonly synthesizePrompt?: (trigger: RoleTrigger) => string;
}

export interface TriggerScheduler {
  start(): void;
  stop(): void;
  reloadRole(roleId: string): void;
  reloadAgent(agentId: string): void;
}

interface ScheduledCron {
  readonly agentId: string;
  readonly roleId: string;
  readonly workspaceId: string;
  readonly trigger: { kind: "cron"; expr: string };
  handle: TimeoutHandle | null;
}

function defaultSynthesize(trigger: RoleTrigger): string {
  if (trigger.kind === "cron") return `a cron fired: ${trigger.expr}`;
  if (trigger.kind === "file-watch") return `a file-watch fired: ${trigger.glob}`;
  if (trigger.kind === "webhook") return `a webhook fired: ${trigger.path}`;
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
  const byAgent = new Map<string, Set<ScheduledCron>>();
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
    const set = byAgent.get(entry.agentId);
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
      fire(entry);
      if (started && isStillTracked(entry)) scheduleNext(entry);
    }, delay);
  }

  function fire(entry: ScheduledCron): void {
    const firedAt = deps.clock.now().getTime();
    const agent = deps.agents.get(entry.agentId);
    if (agent === null) return;
    const role = deps.roles.get(entry.roleId);
    const workspace = deps.workspaces.get(entry.workspaceId);
    if (role === null || workspace === null) return;
    const prompt = synthesize(entry.trigger);

    const activeForAgent = deps.sessions
      .listActiveForWorkspace(entry.workspaceId)
      .filter((s) => s.agent_id === entry.agentId);

    if (activeForAgent.length === 0) {
      const result = deps.attachSession({ workspace, role, agent, prompt });
      const outcome: DispatchOutcome = result.ok ? "spawned" : "errored";
      const sessionId = result.ok ? result.session_id : undefined;
      const error = result.ok ? undefined : result.error;
      deps.dispatches.append({
        workspace_id: entry.workspaceId,
        role_id: entry.roleId,
        agent_id: entry.agentId,
        trigger_kind: entry.trigger.kind,
        trigger_payload: entry.trigger,
        fired_at: firedAt,
        dispatch_outcome: outcome,
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        ...(error === undefined ? {} : { error }),
      });
      return;
    }

    const live = deps.registry.get(activeForAgent[0]!.id);
    if (live === null || live.busy) {
      deps.dispatches.append({
        workspace_id: entry.workspaceId,
        role_id: entry.roleId,
        agent_id: entry.agentId,
        trigger_kind: entry.trigger.kind,
        trigger_payload: entry.trigger,
        fired_at: firedAt,
        dispatch_outcome: "skipped-busy",
      });
      return;
    }

    live.stdin.write(serializeUserMessage(prompt));
    deps.registry.setBusy(live.sessionId, true);
    deps.dispatches.append({
      workspace_id: entry.workspaceId,
      role_id: entry.roleId,
      agent_id: entry.agentId,
      trigger_kind: entry.trigger.kind,
      trigger_payload: entry.trigger,
      fired_at: firedAt,
      dispatch_outcome: "injected",
      session_id: live.sessionId,
    });
  }

  function clearAgent(agentId: string): void {
    const set = byAgent.get(agentId);
    if (set === undefined) return;
    for (const entry of set) {
      if (entry.handle !== null) deps.clock.clearTimeout(entry.handle);
    }
    byAgent.delete(agentId);
  }

  function registerAgent(agentId: string): void {
    const loaded = loadTriggersForAgent(agentId);
    if (loaded === null) return;
    const set = new Set<ScheduledCron>();
    for (const trigger of loaded.triggers) {
      if (trigger.kind !== "cron") continue;
      const entry: ScheduledCron = {
        agentId: loaded.agent.id,
        roleId: loaded.agent.role_id,
        workspaceId: loaded.agent.workspace_id,
        trigger,
        handle: null,
      };
      set.add(entry);
    }
    if (set.size === 0) return;
    byAgent.set(agentId, set);
    for (const entry of set) scheduleNext(entry);
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
    for (const set of byAgent.values()) {
      for (const entry of set) {
        if (entry.handle !== null) deps.clock.clearTimeout(entry.handle);
      }
    }
    byAgent.clear();
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

  return { start, stop, reloadRole, reloadAgent };
}
