import type { SessionStore } from "./session-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";
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
import type { SessionEndedItem, SessionEndedWakePayload } from "./session-ended-wake.ts";

export interface ScheduledSessionEnded extends AgentBinding {
  readonly trigger: { kind: "session-ended" };
}

export interface SessionEndedSchedulerDeps {
  readonly sessions: SessionStore;
  readonly agentStatusLog: AgentStatusLogStore;
}

export interface SessionEndedScheduler {
  register(entry: ScheduledSessionEnded): void;
  clearAgent(agentId: string): void;
  clearAll(): void;
  // Fired from the reaper's callers when a session ends. Wakes each persistent
  // agent in the workspace declaring a `session-ended` trigger with the
  // finished session's outcome (rebuilt from persistent state).
  fireSessionEnded(
    workspaceId: string,
    finishedSessionId: string,
  ): Promise<DispatchResult>;
  // Called on an agent's Stop (busy→idle): delivers any completion wakes that
  // were enqueued while it was busy, coalesced into one.
  flushPendingWakes(agentId: string): Promise<void>;
}

export function createSessionEndedScheduler(
  deps: SessionEndedSchedulerDeps,
  dispatchDeps: DispatchDeps,
): SessionEndedScheduler {
  const byAgent = new Map<string, Set<ScheduledSessionEnded>>();
  const byWorkspace = new Map<string, Set<ScheduledSessionEnded>>();
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

  function register(entry: ScheduledSessionEnded): void {
    addToKeyedIndex(entry, entry.agentId, entry.workspaceId, byAgent, byWorkspace);
  }

  function clearAgent(agentId: string): void {
    clearAgentFromKeyedIndex<ScheduledSessionEnded>(
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
  ): Promise<DispatchResult> {
    const set = byWorkspace.get(workspaceId);
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
    const set = byAgent.get(agentId);
    if (set === undefined) return;
    const entry = set.values().next().value;
    if (entry === undefined) return;
    const payload: SessionEndedWakePayload = { ended: items };
    await dispatchTrigger(dispatchDeps, entry, entry.trigger, payload, enqueueWhileBusy);
  }

  return { register, clearAgent, clearAll, fireSessionEnded, flushPendingWakes };
}
