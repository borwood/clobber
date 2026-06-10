import type { RuntimeProvider } from "@clobber/runtime";
import {
  triggerId,
  type ClobberPromptTag,
  type CreateNotification,
  type RoleTrigger,
  type Workspace,
} from "@clobber/shared";
import type { CompletionWakePayload } from "./completion-wake.ts";
import type { AgentStore } from "./agent-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { Clock } from "./clock.ts";
import type { TriggerDispatchStore } from "./trigger-dispatch-store.ts";
import type { AttachSessionFn } from "./trigger-attach.ts";
import {
  deliver,
  type DeliverDeps,
  type EnqueuePolicy,
  type NotificationDispatcher,
  type ResumeSessionFn,
} from "./notification-dispatch.ts";

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
  readonly resumeEndedSession: ResumeSessionFn;
  readonly dispatcher: NotificationDispatcher;
  readonly synthesize: (trigger: RoleTrigger, payload: unknown) => string;
}

// A trigger fire is the dispatcher's founding emitter: it builds a `trigger`
// notification, routes it through the shared `deliver()` core, and records the
// outcome in the trigger-dispatch audit. The recipient-state → action routing
// (idle→spawn, live-idle→inject, busy→enqueue/skip) lives in deliver(), not
// here. Returns true if the dispatch landed in the audit log; false if the
// agent / role / workspace went away between trigger registration and fire.
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
  const promptTag: ClobberPromptTag = { kind: "trigger", attrs: { via: trigger.kind } };
  const wakeProgram = resolveTriggerWakeProgram(workspace, binding.roleId, trigger);
  const sourceId = triggerSourceId(trigger, payload);

  // All trigger fires are wake signals — high priority so the #605 gate in
  // deliver() lets them through to a sleeping persistent agent. Low priority is
  // reserved for passive informational notifications that wait for the next
  // natural wake (#424 Phase 3).
  const req: CreateNotification = {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: binding.agentId },
    priority: "high",
    payload: { body: prompt, tag: promptTag },
    provenance: {
      source_kind: "trigger",
      ...(sourceId !== undefined ? { source_id: sourceId } : {}),
    },
    metadata: wakeProgram === undefined ? {} : { wake_program: wakeProgram },
  };

  // Adapt the trigger-facing busy policy (which closes over binding/trigger/
  // payload for completion-wake's enqueue) to deliver's recipient-agnostic form.
  const enqueuePolicy: EnqueuePolicy =
    busyPolicy.kind === "drop"
      ? { kind: "drop" }
      : { kind: "enqueue", enqueue: () => busyPolicy.enqueue(binding, trigger, payload) };

  const deliverDeps: DeliverDeps = {
    agents: deps.agents,
    roles: deps.roles,
    workspaces: deps.workspaces,
    sessions: deps.sessions,
    registry: deps.registry,
    runtimeProvider: deps.runtimeProvider,
    attachSession: deps.attachSession,
    resumeEndedSession: deps.resumeEndedSession,
  };

  const { outcome } = await deps.dispatcher.emit(req, (n) =>
    deliver(deliverDeps, n, enqueuePolicy),
  );

  deps.dispatches.append({
    workspace_id: binding.workspaceId,
    role_id: binding.roleId,
    agent_id: binding.agentId,
    trigger_kind: trigger.kind,
    trigger_payload: trigger,
    fired_at: firedAt,
    dispatch_outcome: outcome.action,
    ...(outcome.sessionId === undefined ? {} : { session_id: outcome.sessionId }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  });
  return true;
}

// Derive an occurrence-specific source_id for the notification's provenance so
// the logical_key is per-event, not per-trigger-kind. Without re-graining,
// every worker-done fire would share the same key and collapse → the manager
// misses N-1 completions. Rule: return undefined for trigger kinds that have no
// stable per-occurrence identity; null logical_key = no dedup = today's behavior.
function triggerSourceId(
  trigger: RoleTrigger,
  payload: unknown,
): string | undefined {
  switch (trigger.kind) {
    case "worker-done":
    case "session-ended": {
      // Prefix with trigger.kind so worker-done and session-ended for the same
      // session have different logical keys — they are distinct events (#424).
      // Sorted session IDs make coalesced (multi-ended) wakes deterministic.
      const sessionKey = (payload as CompletionWakePayload).ended
        .map((i) => i.sessionId)
        .sort()
        .join(",");
      return `${trigger.kind}:${sessionKey}`;
    }
    case "cron":
      // No stable occurrence identity: the scheduler's tick timestamp is not
      // threaded to dispatchTrigger, so any key we could build here would use
      // wall-clock dispatch time — unique per call, never actually dedups.
      // Return undefined: honest no-dedup, null logical_key, always-inserted.
      return undefined;
    default:
      return undefined;
  }
}

// Resolves a fired trigger to its wake-program: a workspace per-trigger override
// (trigger_overrides[roleId].wake_programs) layered over the role-authored
// default on the trigger. Undefined when neither maps — the synthesized prompt
// stays the opening kick (the legacy seam). Mirrors how trigger enable/disable
// resolves a workspace override over the role's enabled-by-default state. (#213)
function resolveTriggerWakeProgram(
  workspace: Workspace,
  roleId: string,
  trigger: RoleTrigger,
): string | undefined {
  const override = workspace.trigger_overrides[roleId]?.wake_programs?.[triggerId(trigger)];
  return override === undefined ? trigger.wake_program : override;
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
