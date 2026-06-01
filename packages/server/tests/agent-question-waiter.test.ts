import { describe, it, expect } from "bun:test";
import type { AgentQuestion } from "@clobber/shared";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";

function fakeQuestion(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id: "q1",
    session_id: "s1",
    questions: [{ question: "go?", multi_select: false }],
    status: "pending",
    asked_at: 1,
    ...overrides,
  };
}

describe("agent question waiter", () => {
  it("resolves status=notified with the question when notify() is called", async () => {
    const waiter = createAgentQuestionWaiter();
    const promise = waiter.wait("q1", 5_000);
    const resolved = fakeQuestion({ status: "answered", answer: "yes", answered_at: 2 });
    waiter.notify(resolved);
    expect(await promise).toEqual({ status: "notified", question: resolved });
  });

  it("resolves status=still_waiting when the window elapses with no notify (no expiry — the ask is NOT failed)", async () => {
    const waiter = createAgentQuestionWaiter();
    const start = Date.now();
    const outcome = await waiter.wait("q1", 30);
    expect(outcome).toEqual({ status: "still_waiting" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("notify on an unknown id is a no-op", () => {
    const waiter = createAgentQuestionWaiter();
    expect(() => waiter.notify(fakeQuestion({ id: "nope" }))).not.toThrow();
  });

  it("notify after the window has elapsed is a no-op (no late resolution)", async () => {
    const waiter = createAgentQuestionWaiter();
    const outcome = await waiter.wait("q1", 20);
    expect(outcome).toEqual({ status: "still_waiting" });
    // Late notify must not throw and must not produce an unhandled rejection.
    waiter.notify(fakeQuestion({ id: "q1", status: "answered", answer: "late" }));
  });

  it("supports concurrent waiters for distinct ids", async () => {
    const waiter = createAgentQuestionWaiter();
    const pA = waiter.wait("a", 5_000);
    const pB = waiter.wait("b", 5_000);

    waiter.notify(fakeQuestion({ id: "b", status: "answered", answer: "B!" }));
    const b = await pB;
    expect(b.status).toBe("notified");
    if (b.status === "notified") expect(b.question.answer).toBe("B!");

    waiter.notify(fakeQuestion({ id: "a", status: "cancelled", answered_at: 9 }));
    const a = await pA;
    expect(a.status).toBe("notified");
    if (a.status === "notified") expect(a.question.status).toBe("cancelled");
  });
});
