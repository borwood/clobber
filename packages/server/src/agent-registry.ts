/**
 * In-process registry of live spawned agents. Lives only in memory — its
 * sole purpose is to (a) hold each child's stdin so prompt routes can write
 * to it, and (b) track per-session "busy" state so concurrent prompts
 * serialize via 409 instead of interleaving turns.
 *
 * busy semantics: true from spawn (initial turn in flight) and from each
 * prompt write until the matching `Stop` hook fires.
 */
export interface LiveAgent {
  readonly sessionId: string;
  readonly stdin: NodeJS.WritableStream;
  busy: boolean;
}

export interface AgentRegistry {
  register(sessionId: string, stdin: NodeJS.WritableStream): void;
  get(sessionId: string): LiveAgent | null;
  unregister(sessionId: string): void;
  setBusy(sessionId: string, busy: boolean): void;
}

export function createAgentRegistry(): AgentRegistry {
  const live = new Map<string, LiveAgent>();
  return {
    register(sessionId, stdin) {
      live.set(sessionId, { sessionId, stdin, busy: true });
    },
    get(sessionId) {
      const agent = live.get(sessionId);
      return agent === undefined ? null : agent;
    },
    unregister(sessionId) {
      live.delete(sessionId);
    },
    setBusy(sessionId, busy) {
      const agent = live.get(sessionId);
      if (agent === undefined) return;
      agent.busy = busy;
    },
  };
}
