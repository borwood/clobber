import {
  dispatchTrigger,
  type AgentBinding,
  type BusyPolicy,
  type DispatchDeps,
  type DispatchResult,
} from "./trigger-dispatch.ts";
import {
  addToKeyedIndex,
  clearAgentFromKeyedIndex,
} from "./trigger-keyed-index.ts";
import { createAgentWorkQueue } from "./agent-work-queue.ts";
import type { CompletionWakeItem, CompletionWakePayload } from "./completion-wake.ts";

// The trigger kinds that fire a completion wake: a worker finishing (`worker-done`)
// or a session ending (`session-ended`). Both share this scheduler — keyed
// index, busy-aware enqueue, and flush-on-idle coalescing — and differ only in
// how the wake item is rebuilt from persistent state.
export type CompletionWakeKind = "session-ended" | "worker-done";

export interface ScheduledCompletionWake extends AgentBinding {
  readonly trigger: { kind: CompletionWakeKind };
}

// Rebuilds a wake item from persistent state for the finished session, or null
// when the session is gone. The ephemeral agent may already be reaped — the
// session row and its log rows survive. completionId pins the row id captured
// at the route so re-fetching "latest" can't return a different row under a race.
export type BuildCompletionWakeItem = (sessionId: string, completionId?: number) => CompletionWakeItem | null;

// #619 defense: returns the agent_id that owns the finished session so fire()
// can exclude it from the recipient set. Absent → no exclusion (session-ended
// wake has no need to exclude a persistent recipient).
export type ExcludeFinisherFor = (finishedSessionId: string) => string | undefined;

export interface CompletionWakeScheduler {
  register(entry: ScheduledCompletionWake): void;
  clearAgent(agentId: string): void;
  clearAll(): void;
  // Fired when a session completes (ended, or a worker posted status=done).
  // Wakes each persistent agent in the workspace declaring this kind.
  fire(workspaceId: string, finishedSessionId: string, completionId?: number): Promise<DispatchResult>;
  // Called on an agent's Stop (busy→idle): delivers any completion wakes that
  // were enqueued while it was busy, coalesced into one.
  flushPendingWakes(agentId: string): Promise<void>;
}

export function createCompletionWakeScheduler(
  kind: CompletionWakeKind,
  buildItem: BuildCompletionWakeItem,
  dispatchDeps: DispatchDeps,
  excludeFinisherFor?: ExcludeFinisherFor,
): CompletionWakeScheduler {
  const byAgent = new Map<string, Set<ScheduledCompletionWake>>();
  const byWorkspace = new Map<string, Set<ScheduledCompletionWake>>();
  // Completion wakes that arrived while the target agent was busy, held per
  // agent until its next idle (the Stop hook → flushPendingWakes).
  const pendingWakes = createAgentWorkQueue<CompletionWakeItem>();
  const enqueueWhileBusy: BusyPolicy = {
    kind: "enqueue",
    enqueue: (binding, _trigger, payload) => {
      for (const item of (payload as CompletionWakePayload).ended) {
        pendingWakes.enqueue(binding.agentId, item);
      }
    },
  };

  function register(entry: ScheduledCompletionWake): void {
    addToKeyedIndex(entry, entry.agentId, entry.workspaceId, byAgent, byWorkspace);
  }

  function clearAgent(agentId: string): void {
    clearAgentFromKeyedIndex<ScheduledCompletionWake>(
      agentId,
      (e) => e.workspaceId,
      byAgent,
      byWorkspace,
    );
    pendingWakes.clear(agentId);
  }

  function clearAll(): void {
    byAgent.clear();
    byWorkspace.clear();
  }

  async function fire(
    workspaceId: string,
    finishedSessionId: string,
    completionId?: number,
  ): Promise<DispatchResult> {
    const set = byWorkspace.get(workspaceId);
    if (set === undefined) return { dispatched: 0 };
    const item = buildItem(finishedSessionId, completionId);
    if (item === null) return { dispatched: 0 };
    const payload: CompletionWakePayload = { ended: [item] };
    // #619: exclude the finishing agent from its own wake to prevent self-fire
    // when the finisher is also registered as a recipient.
    const excludeAgentId = excludeFinisherFor?.(finishedSessionId);
    let dispatched = 0;
    for (const entry of set) {
      if (excludeAgentId !== undefined && entry.agentId === excludeAgentId) continue;
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
    const set = byAgent.get(agentId);
    if (set === undefined) return;
    const entry = set.values().next().value;
    if (entry === undefined) return;
    const payload: CompletionWakePayload = { ended: items };
    await dispatchTrigger(dispatchDeps, entry, entry.trigger, payload, enqueueWhileBusy);
  }

  return { register, clearAgent, clearAll, fire, flushPendingWakes };
}
