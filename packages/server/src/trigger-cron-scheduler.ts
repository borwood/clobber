import parser from "cron-parser";
import type { Clock, TimeoutHandle } from "./clock.ts";
import {
  dispatchTrigger,
  type AgentBinding,
  type DispatchDeps,
} from "./trigger-dispatch.ts";

export interface ScheduledCron extends AgentBinding {
  readonly trigger: { kind: "cron"; expr: string };
  handle: TimeoutHandle | null;
}

export interface CronScheduler {
  register(entry: ScheduledCron): void;
  clearAgent(agentId: string): void;
  clearAll(): void;
}

export function createCronScheduler(
  clock: Clock,
  dispatchDeps: DispatchDeps,
  isStarted: () => boolean,
): CronScheduler {
  const byAgent = new Map<string, Set<ScheduledCron>>();

  function isStillTracked(entry: ScheduledCron): boolean {
    const set = byAgent.get(entry.agentId);
    return set !== undefined && set.has(entry);
  }

  function scheduleNext(entry: ScheduledCron): void {
    const now = clock.now();
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
    entry.handle = clock.setTimeout(() => {
      entry.handle = null;
      // Reschedule the next tick immediately so cadence is independent of how
      // long the dispatch (which may run an async boot-context provider) takes;
      // dispatchTrigger records its own outcome and never rejects.
      void dispatchTrigger(dispatchDeps, entry, entry.trigger, undefined);
      if (isStarted() && isStillTracked(entry)) scheduleNext(entry);
    }, delay);
  }

  function register(entry: ScheduledCron): void {
    let set = byAgent.get(entry.agentId);
    if (set === undefined) {
      set = new Set<ScheduledCron>();
      byAgent.set(entry.agentId, set);
    }
    set.add(entry);
    scheduleNext(entry);
  }

  function clearAgent(agentId: string): void {
    const set = byAgent.get(agentId);
    if (set === undefined) return;
    for (const entry of set) {
      if (entry.handle !== null) clock.clearTimeout(entry.handle);
    }
    byAgent.delete(agentId);
  }

  function clearAll(): void {
    for (const set of byAgent.values()) {
      for (const entry of set) {
        if (entry.handle !== null) clock.clearTimeout(entry.handle);
      }
    }
    byAgent.clear();
  }

  return { register, clearAgent, clearAll };
}
