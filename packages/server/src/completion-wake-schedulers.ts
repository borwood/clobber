import type { SessionStore } from "./session-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";
import type { DispatchDeps, DispatchResult } from "./trigger-dispatch.ts";
import type { CompletionWakeItem } from "./completion-wake.ts";
import {
  createCompletionWakeScheduler,
  type ScheduledCompletionWake,
} from "./trigger-completion-wake.ts";

export interface CompletionWakeSchedulerDeps {
  readonly sessions: SessionStore;
  readonly agentStatusLog: AgentStatusLogStore;
}

// The pair of completion-wake schedulers (`session-ended`, `worker-done`) the
// trigger scheduler composes. They share one machine (trigger-completion-wake)
// and differ only in how the wake item is rebuilt from persistent state:
// session-ended reads the final-report row, worker-done the worker's latest
// status row (the `done` it just posted). The ephemeral agent may be reaped,
// but the session row and its log rows survive. See #171, #240.
export interface CompletionWakeSchedulers {
  registerSessionEnded(entry: ScheduledCompletionWake): void;
  registerWorkerDone(entry: ScheduledCompletionWake): void;
  clearAgent(agentId: string): void;
  clearAll(): void;
  fireSessionEnded(workspaceId: string, finishedSessionId: string): Promise<DispatchResult>;
  fireWorkerDone(workspaceId: string, finishedSessionId: string, completionId?: number): Promise<DispatchResult>;
  // Drains both schedulers' busy-queues on the target's next idle.
  flushPendingWakes(agentId: string): Promise<void>;
}

export function createCompletionWakeSchedulers(
  deps: CompletionWakeSchedulerDeps,
  dispatchDeps: DispatchDeps,
): CompletionWakeSchedulers {
  const buildEndedItem = (sessionId: string): CompletionWakeItem | null => {
    const session = deps.sessions.get(sessionId);
    if (session === null) return null;
    const report = deps.agentStatusLog.latestForSession(sessionId, "final-report");
    return {
      sessionId,
      label: session.label === undefined ? null : session.label,
      summary: report === null ? null : report.summary,
      ...(report !== null ? { completionId: report.id } : {}),
    };
  };
  const buildDoneItem = (sessionId: string, completionId?: number): CompletionWakeItem | null => {
    const session = deps.sessions.get(sessionId);
    if (session === null) return null;
    const status = deps.agentStatusLog.latestForSession(sessionId, "status");
    // Use the pinned completionId from the route when provided. Pinning prevents
    // a race where a second rapid post replaces "latest" before this read, which
    // would give two fires the same row id → same logical_key → wrong dedup (#620 HIGH).
    const resolvedId = completionId ?? (status !== null ? status.id : undefined);
    return {
      sessionId,
      label: session.label === undefined ? null : session.label,
      summary: status === null ? null : status.summary,
      ...(resolvedId !== undefined ? { completionId: resolvedId } : {}),
    };
  };

  const sessionEnded = createCompletionWakeScheduler("session-ended", buildEndedItem, dispatchDeps);
  // #619: pass excludeFinisherFor so fire() skips the finishing agent's own entry.
  const workerDone = createCompletionWakeScheduler(
    "worker-done",
    buildDoneItem,
    dispatchDeps,
    (sid) => deps.sessions.get(sid)?.agent_id ?? undefined,
  );

  return {
    registerSessionEnded: sessionEnded.register,
    registerWorkerDone: workerDone.register,
    clearAgent(agentId) {
      sessionEnded.clearAgent(agentId);
      workerDone.clearAgent(agentId);
    },
    clearAll() {
      sessionEnded.clearAll();
      workerDone.clearAll();
    },
    fireSessionEnded: sessionEnded.fire,
    fireWorkerDone(workspaceId, finishedSessionId, completionId) {
      return workerDone.fire(workspaceId, finishedSessionId, completionId);
    },
    async flushPendingWakes(agentId) {
      await sessionEnded.flushPendingWakes(agentId);
      await workerDone.flushPendingWakes(agentId);
    },
  };
}
