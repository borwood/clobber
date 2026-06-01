import type { AgentQuestion } from "@clobber/shared";

/**
 * The outcome of one bounded wait. `notified` carries the resolved question (a
 * human answered, or the ask was cancelled/superseded). `still_waiting` means
 * the poll window elapsed with no resolution — the ask is NOT failed; the row
 * stays pending and the caller re-arms. A blocking ask has no deadline (#241),
 * so the wait window is a long-poll heartbeat, never an expiry.
 */
export type WaitOutcome =
  | { readonly status: "notified"; readonly question: AgentQuestion }
  | { readonly status: "still_waiting" };

interface Waiter {
  resolve: (outcome: WaitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentQuestionWaiter {
  wait(id: string, windowMs: number): Promise<WaitOutcome>;
  notify(question: AgentQuestion): void;
}

export function createAgentQuestionWaiter(): AgentQuestionWaiter {
  const waiters = new Map<string, Waiter>();

  return {
    wait(id, windowMs) {
      return new Promise<WaitOutcome>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          resolve({ status: "still_waiting" });
        }, windowMs);
        waiters.set(id, { resolve, timer });
      });
    },

    notify(question) {
      const w = waiters.get(question.id);
      if (w === undefined) return;
      waiters.delete(question.id);
      clearTimeout(w.timer);
      w.resolve({ status: "notified", question });
    },
  };
}
