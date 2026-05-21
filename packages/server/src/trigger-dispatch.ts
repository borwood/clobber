import type { RuntimeProvider } from "@clobber/runtime";
import type { RoleTrigger } from "@clobber/shared";
import type { AgentStore } from "./agent-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { Clock } from "./clock.ts";
import type {
  TriggerDispatchStore,
  DispatchOutcome,
} from "./trigger-dispatch-store.ts";
import type { AttachSessionFn } from "./trigger-scheduler.ts";

export interface AgentBinding {
  readonly agentId: string;
  readonly roleId: string;
  readonly workspaceId: string;
}

export interface DispatchDeps {
  readonly clock: Clock;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly workspaces: WorkspaceStore;
  readonly sessions: SessionStore;
  readonly registry: AgentRegistry;
  readonly runtimeProvider: RuntimeProvider;
  readonly dispatches: TriggerDispatchStore;
  readonly attachSession: AttachSessionFn;
  readonly synthesize: (trigger: RoleTrigger, payload: unknown) => string;
}

// Centralized fire-to-session flow shared by every trigger kind. Spawns a
// fresh session if the agent is idle, injects into a live+idle session, or
// records skipped-busy / errored otherwise. Returns true if the dispatch
// landed in the audit log; false if the agent / role / workspace went away
// between trigger registration and fire.
export function dispatchTrigger(
  deps: DispatchDeps,
  binding: AgentBinding,
  trigger: RoleTrigger,
  payload: unknown,
): boolean {
  const firedAt = deps.clock.now().getTime();
  const agent = deps.agents.get(binding.agentId);
  if (agent === null) return false;
  const role = deps.roles.get(binding.roleId);
  const workspace = deps.workspaces.get(binding.workspaceId);
  if (role === null || workspace === null) return false;
  const prompt = deps.synthesize(trigger, payload);

  const activeForAgent = deps.sessions
    .listActiveForWorkspace(binding.workspaceId)
    .filter((s) => s.agent_id === binding.agentId);

  if (activeForAgent.length === 0) {
    const result = deps.attachSession({ workspace, role, agent, prompt });
    const outcome: DispatchOutcome = result.ok ? "spawned" : "errored";
    const sessionId = result.ok ? result.session_id : undefined;
    const error = result.ok ? undefined : result.error;
    deps.dispatches.append({
      workspace_id: binding.workspaceId,
      role_id: binding.roleId,
      agent_id: binding.agentId,
      trigger_kind: trigger.kind,
      trigger_payload: trigger,
      fired_at: firedAt,
      dispatch_outcome: outcome,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(error === undefined ? {} : { error }),
    });
    return true;
  }

  const live = deps.registry.get(activeForAgent[0]!.id);
  if (live === null || live.busy) {
    deps.dispatches.append({
      workspace_id: binding.workspaceId,
      role_id: binding.roleId,
      agent_id: binding.agentId,
      trigger_kind: trigger.kind,
      trigger_payload: trigger,
      fired_at: firedAt,
      dispatch_outcome: "skipped-busy",
    });
    return true;
  }

  if (!deps.runtimeProvider.capabilities.livePromptInjection) {
    deps.dispatches.append({
      workspace_id: binding.workspaceId,
      role_id: binding.roleId,
      agent_id: binding.agentId,
      trigger_kind: trigger.kind,
      trigger_payload: trigger,
      fired_at: firedAt,
      dispatch_outcome: "errored",
      error: "runtime does not support live prompt injection",
    });
    return true;
  }

  live.stdin.write(deps.runtimeProvider.serializeUserPrompt(prompt));
  deps.registry.setBusy(live.sessionId, true);
  deps.dispatches.append({
    workspace_id: binding.workspaceId,
    role_id: binding.roleId,
    agent_id: binding.agentId,
    trigger_kind: trigger.kind,
    trigger_payload: trigger,
    fired_at: firedAt,
    dispatch_outcome: "injected",
    session_id: live.sessionId,
  });
  return true;
}

export function recordUnsupportedTrigger(
  deps: Pick<DispatchDeps, "dispatches" | "clock">,
  binding: AgentBinding,
  trigger: RoleTrigger,
): void {
  deps.dispatches.append({
    workspace_id: binding.workspaceId,
    role_id: binding.roleId,
    agent_id: binding.agentId,
    trigger_kind: trigger.kind,
    trigger_payload: trigger,
    fired_at: deps.clock.now().getTime(),
    dispatch_outcome: "unsupported-kind",
    error: `trigger kind "${trigger.kind}" has no live event source — declared but never fires`,
  });
}

// Mirrors recordUnsupportedTrigger so an explicit per-workspace disable stays
// visible in the dispatch log. The modularity-gap principle from PR #143
// applies: nothing silently dropped — declared-but-disabled triggers leave a
// breadcrumb.
export function recordDisabledTrigger(
  deps: Pick<DispatchDeps, "dispatches" | "clock">,
  binding: AgentBinding,
  trigger: RoleTrigger,
  triggerIdValue: string,
): void {
  deps.dispatches.append({
    workspace_id: binding.workspaceId,
    role_id: binding.roleId,
    agent_id: binding.agentId,
    trigger_kind: trigger.kind,
    trigger_payload: trigger,
    fired_at: deps.clock.now().getTime(),
    dispatch_outcome: "disabled-by-workspace",
    error: `trigger "${triggerIdValue}" is disabled by workspace config`,
  });
}
