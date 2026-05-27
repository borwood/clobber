import type { RuntimeProvider } from "@clobber/runtime";
import type { Agent, Role, RoleTrigger, Workspace } from "@clobber/shared";
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
import type { AttachOutcome, AttachSessionFn } from "./trigger-attach.ts";

export interface AgentBinding {
  readonly agentId: string;
  readonly roleId: string;
  readonly workspaceId: string;
}

// How many bindings a fire-path actually dispatched to. Shared across every
// fire entry point (webhook, workspace-open, session-ended).
export interface DispatchResult {
  readonly dispatched: number;
}

// What dispatchTrigger does when the target session is live but busy. The
// default (`drop`) preserves cron/webhook semantics: record skipped-busy and
// move on. `enqueue` is for wakes that must not be lost — the queued item is
// handed to a substrate (see agent-work-queue) and flushed when the agent goes
// idle. #171 uses this so a busy manager never drops a completion signal.
export type BusyPolicy =
  | { readonly kind: "drop" }
  | {
      readonly kind: "enqueue";
      readonly enqueue: (
        binding: AgentBinding,
        trigger: RoleTrigger,
        payload: unknown,
      ) => void;
    };

const DROP_ON_BUSY: BusyPolicy = { kind: "drop" };

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
export async function dispatchTrigger(
  deps: DispatchDeps,
  binding: AgentBinding,
  trigger: RoleTrigger,
  payload: unknown,
  busyPolicy: BusyPolicy = DROP_ON_BUSY,
): Promise<boolean> {
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
    // attachSession can now throw — a configured boot-context provider that
    // fails (Engineering Rule 3) propagates out of spawn-context. On a fire-
    // and-forget trigger path there's no caller to surface a 500 to, so we
    // translate the throw into an errored dispatch (the same audit outcome a
    // non-ok result produces) rather than crashing the cron timer. This is
    // not a Rule-3 swallow: the failure is recorded loudly in the dispatch
    // log with its message, not discarded. Trigger-path semantics per #166.
    const attached = await attachOutcome(deps, { workspace, role, agent, prompt });
    deps.dispatches.append({
      workspace_id: binding.workspaceId,
      role_id: binding.roleId,
      agent_id: binding.agentId,
      trigger_kind: trigger.kind,
      trigger_payload: trigger,
      fired_at: firedAt,
      dispatch_outcome: attached.outcome,
      ...(attached.sessionId === undefined ? {} : { session_id: attached.sessionId }),
      ...(attached.error === undefined ? {} : { error: attached.error }),
    });
    return true;
  }

  const live = deps.registry.get(activeForAgent[0]!.id);
  if (live === null || live.busy) {
    if (live !== null && busyPolicy.kind === "enqueue") {
      busyPolicy.enqueue(binding, trigger, payload);
      deps.dispatches.append({
        workspace_id: binding.workspaceId,
        role_id: binding.roleId,
        agent_id: binding.agentId,
        trigger_kind: trigger.kind,
        trigger_payload: trigger,
        fired_at: firedAt,
        dispatch_outcome: "queued",
        session_id: live.sessionId,
      });
      return true;
    }
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

interface AttachOutcomeResult {
  readonly outcome: DispatchOutcome;
  readonly sessionId?: string;
  readonly error?: string;
}

async function attachOutcome(
  deps: Pick<DispatchDeps, "attachSession">,
  input: { workspace: Workspace; role: Role; agent: Agent; prompt: string },
): Promise<AttachOutcomeResult> {
  let result: AttachOutcome;
  try {
    result = await deps.attachSession(input);
  } catch (err) {
    return { outcome: "errored", error: err instanceof Error ? err.message : String(err) };
  }
  if (result.ok) return { outcome: "spawned", sessionId: result.session_id };
  return { outcome: "errored", error: result.error };
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
