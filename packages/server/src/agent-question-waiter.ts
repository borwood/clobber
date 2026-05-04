import type { AgentQuestion } from "@clobber/shared";

export class QuestionTimeoutError extends Error {
  constructor(public readonly questionId: string) {
    super(`question ${questionId} timed out`);
    this.name = "QuestionTimeoutError";
  }
}

interface Waiter {
  resolve: (q: AgentQuestion) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentQuestionWaiter {
  wait(id: string, timeoutMs: number): Promise<AgentQuestion>;
  notify(question: AgentQuestion): void;
}

export function createAgentQuestionWaiter(): AgentQuestionWaiter {
  const waiters = new Map<string, Waiter>();

  return {
    wait(id, timeoutMs) {
      return new Promise<AgentQuestion>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new QuestionTimeoutError(id));
        }, timeoutMs);
        waiters.set(id, { resolve, reject, timer });
      });
    },

    notify(question) {
      const w = waiters.get(question.id);
      if (w === undefined) return;
      waiters.delete(question.id);
      clearTimeout(w.timer);
      w.resolve(question);
    },
  };
}
