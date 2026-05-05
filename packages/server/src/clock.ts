export type TimeoutHandle = number;

export interface Clock {
  now(): Date;
  setTimeout(cb: () => void, ms: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

export interface TestClock extends Clock {
  advance(ms: number): void;
}

export function createSystemClock(): Clock {
  return {
    now: () => new Date(),
    setTimeout(cb, ms) {
      return globalThis.setTimeout(cb, ms) as unknown as TimeoutHandle;
    },
    clearTimeout(handle) {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>);
    },
  };
}

interface ScheduledTask {
  readonly id: number;
  readonly fireAt: number;
  readonly cb: () => void;
  cancelled: boolean;
}

export function createTestClock(initial: Date): TestClock {
  let nowMs = initial.getTime();
  let nextId = 1;
  const tasks: ScheduledTask[] = [];

  function drainUpTo(targetMs: number): void {
    for (;;) {
      tasks.sort((a, b) => a.fireAt - b.fireAt);
      const next = tasks[0];
      if (next === undefined) return;
      if (next.fireAt > targetMs) return;
      tasks.shift();
      nowMs = next.fireAt;
      if (!next.cancelled) next.cb();
    }
  }

  return {
    now: () => new Date(nowMs),
    setTimeout(cb, ms) {
      const id = nextId;
      nextId += 1;
      tasks.push({ id, fireAt: nowMs + ms, cb, cancelled: false });
      return id;
    },
    clearTimeout(handle) {
      for (const t of tasks) {
        if (t.id === handle) t.cancelled = true;
      }
    },
    advance(ms) {
      const target = nowMs + ms;
      drainUpTo(target);
      nowMs = target;
    },
  };
}
