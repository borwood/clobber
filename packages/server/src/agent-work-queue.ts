// A per-agent FIFO of pending work to deliver when the agent next becomes
// idle. Extracted as a reusable substrate rather than buried in the trigger
// dispatcher: session-ended completion wakes use it to survive a busy manager
// (#171), and #113 (queue user messages while busy) is the second intended
// consumer. The queue is deliberately agnostic to what it carries.
export interface AgentWorkQueue<T> {
  enqueue(agentId: string, item: T): void;
  // Removes and returns everything queued for the agent (oldest first). The
  // caller decides how to coalesce the batch into a single delivery.
  drain(agentId: string): T[];
  clear(agentId: string): void;
}

export function createAgentWorkQueue<T>(): AgentWorkQueue<T> {
  const byAgent = new Map<string, T[]>();
  return {
    enqueue(agentId, item) {
      const queue = byAgent.get(agentId);
      if (queue === undefined) {
        byAgent.set(agentId, [item]);
        return;
      }
      queue.push(item);
    },
    drain(agentId) {
      const queue = byAgent.get(agentId);
      if (queue === undefined) return [];
      byAgent.delete(agentId);
      return queue;
    },
    clear(agentId) {
      byAgent.delete(agentId);
    },
  };
}
