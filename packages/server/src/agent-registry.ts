/**
 * In-process registry of live spawned agents. Lives only in memory — its
 * sole purpose is to (a) hold each child's stdin so prompt routes can write
 * to it, and (b) track per-session "busy" state so concurrent prompts
 * serialize via 409 instead of interleaving turns.
 *
 * busy semantics: true when a turn is in flight (a spawn with a kick, or a
 * prompt write) and cleared by the matching `Stop` hook. A resume that
 * suppresses the kick registers with no turn in flight (`busy: false`), so it
 * isn't stuck busy forever waiting on a `Stop` that never comes (#366).
 */
export interface LiveAgent {
  readonly sessionId: string;
  readonly stdin: NodeJS.WritableStream;
  readonly kill: (signal: NodeJS.Signals) => void;
  busy: boolean;
}

export interface AgentRegistry {
  register(
    sessionId: string,
    stdin: NodeJS.WritableStream,
    kill: (signal: NodeJS.Signals) => void,
    busy: boolean,
  ): void;
  get(sessionId: string): LiveAgent | null;
  unregister(sessionId: string): void;
  setBusy(sessionId: string, busy: boolean): void;
}

export function createAgentRegistry(): AgentRegistry {
  const live = new Map<string, LiveAgent>();
  return {
    register(sessionId, stdin, kill, busy) {
      live.set(sessionId, { sessionId, stdin, kill, busy });
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
