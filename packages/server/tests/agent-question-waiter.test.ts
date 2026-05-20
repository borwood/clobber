import { describe, it, expect } from "bun:test";
import type { AgentQuestion } from "@clobber/shared";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";

function fakeQuestion(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id: "q1",
    session_id: "s1",
    question: "go?",
    status: "pending",
    multi_select: false,
    asked_at: 1,
    ...overrides,
  };
}

describe("agent question waiter", () => {
  it("resolves with the notified question when notify() is called", async () => {
    const waiter = createAgentQuestionWaiter();
    const promise = waiter.wait("q1", 5_000);
    const resolved = fakeQuestion({ status: "answered", answer: "yes", answered_at: 2 });
    waiter.notify(resolved);
    expect(await promise).toEqual(resolved);
  });

  it("rejects with QuestionTimeoutError when no notify arrives before the deadline", async () => {
    const waiter = createAgentQuestionWaiter();
    const start = Date.now();
    await expect(waiter.wait("q1", 30)).rejects.toMatchObject({
      name: "QuestionTimeoutError",
      questionId: "q1",
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("notify on an unknown id is a no-op", () => {
    const waiter = createAgentQuestionWaiter();
    expect(() => waiter.notify(fakeQuestion({ id: "nope" }))).not.toThrow();
  });

  it("notify after a timeout has fired is a no-op (no late resolution)", async () => {
    const waiter = createAgentQuestionWaiter();
    const promise = waiter.wait("q1", 20).catch((e) => e);
    const err = await promise;
    expect(err).toMatchObject({ name: "QuestionTimeoutError" });
    // Late notify should not throw and not produce an unhandled rejection.
    waiter.notify(fakeQuestion({ id: "q1", status: "answered", answer: "late" }));
  });

  it("supports concurrent waiters for distinct ids", async () => {
    const waiter = createAgentQuestionWaiter();
    const pA = waiter.wait("a", 5_000);
    const pB = waiter.wait("b", 5_000);

    waiter.notify(fakeQuestion({ id: "b", status: "answered", answer: "B!" }));
    expect((await pB).answer).toBe("B!");

    waiter.notify(fakeQuestion({ id: "a", status: "cancelled", answered_at: 9 }));
    expect((await pA).status).toBe("cancelled");
  });
});
