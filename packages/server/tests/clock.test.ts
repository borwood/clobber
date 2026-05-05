import { describe, it, expect } from "bun:test";
import { createSystemClock, createTestClock } from "../src/clock.ts";

describe("system clock", () => {
  it("now() returns a Date close to wall-clock time", () => {
    const clock = createSystemClock();
    const before = Date.now();
    const t = clock.now().getTime();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("setTimeout fires the callback after the given ms", async () => {
    const clock = createSystemClock();
    let fired = false;
    await new Promise<void>((resolve) => {
      clock.setTimeout(() => {
        fired = true;
        resolve();
      }, 10);
    });
    expect(fired).toBe(true);
  });

  it("clearTimeout cancels a pending callback", async () => {
    const clock = createSystemClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 20);
    clock.clearTimeout(handle);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(false);
  });
});

describe("test clock", () => {
  it("now() reflects the constructed time", () => {
    const clock = createTestClock(new Date("2026-05-05T09:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-05-05T09:00:00.000Z");
  });

  it("advance(ms) moves the clock forward", () => {
    const clock = createTestClock(new Date("2026-05-05T09:00:00Z"));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe("2026-05-05T09:01:00.000Z");
  });

  it("setTimeout fires when advance crosses its deadline", () => {
    const clock = createTestClock(new Date("2026-05-05T09:00:00Z"));
    const fires: string[] = [];
    clock.setTimeout(() => fires.push("a"), 1_000);
    clock.setTimeout(() => fires.push("b"), 2_000);
    clock.advance(500);
    expect(fires).toEqual([]);
    clock.advance(500);
    expect(fires).toEqual(["a"]);
    clock.advance(1_000);
    expect(fires).toEqual(["a", "b"]);
  });

  it("setTimeout fires in deadline order regardless of registration order", () => {
    const clock = createTestClock(new Date("2026-05-05T09:00:00Z"));
    const fires: string[] = [];
    clock.setTimeout(() => fires.push("late"), 5_000);
    clock.setTimeout(() => fires.push("early"), 1_000);
    clock.setTimeout(() => fires.push("mid"), 3_000);
    clock.advance(10_000);
    expect(fires).toEqual(["early", "mid", "late"]);
  });

  it("clearTimeout cancels a pending callback", () => {
    const clock = createTestClock(new Date("2026-05-05T09:00:00Z"));
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 1_000);
    clock.clearTimeout(handle);
    clock.advance(5_000);
    expect(fired).toBe(false);
  });

  it("re-entrant setTimeout from inside a callback still fires", () => {
    const clock = createTestClock(new Date("2026-05-05T09:00:00Z"));
    const fires: number[] = [];
    clock.setTimeout(() => {
      fires.push(1);
      clock.setTimeout(() => fires.push(2), 1_000);
    }, 1_000);
    clock.advance(2_500);
    expect(fires).toEqual([1, 2]);
  });
});
