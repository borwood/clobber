import type { PersistentAgentCard } from "../api.ts";
import { relativeTime } from "./relative-time.ts";

interface WhiteboardViewProps {
  readonly agents: readonly PersistentAgentCard[];
  readonly now: number;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onWake: (agentId: string) => void;
  readonly busyAgentIds: ReadonlySet<string>;
}

interface CardState {
  readonly badge: string;
  readonly dot: string;
  readonly accent: string;
}

function stateOf(card: PersistentAgentCard): CardState {
  if (card.active_session === null) {
    return {
      badge: "idle",
      dot: "bg-zinc-500",
      accent: "border-l-zinc-700",
    };
  }
  if (card.active_session.busy) {
    return {
      badge: "working",
      dot: "bg-emerald-500",
      accent: "border-l-emerald-500",
    };
  }
  return {
    badge: "awake",
    dot: "bg-sky-500",
    accent: "border-l-sky-500",
  };
}

export function WhiteboardView(props: WhiteboardViewProps) {
  const { agents, now, onOpenSession, onWake, busyAgentIds } = props;
  if (agents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-zinc-500 text-sm">
          No persistent agents in this workspace yet — spawn a manager or other
          persistent role to populate the whiteboard.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {agents.map((agent) => {
          const state = stateOf(agent);
          const isBusy = busyAgentIds.has(agent.agent_id);
          const handleClick = () => {
            if (agent.active_session !== null) {
              onOpenSession(agent.active_session.id);
              return;
            }
            if (isBusy) return;
            onWake(agent.agent_id);
          };
          const lastActive =
            agent.active_session !== null
              ? `started ${relativeTime(now, agent.active_session.started_at)}`
              : agent.last_started_at === null
                ? "never started"
                : `last awake ${relativeTime(now, agent.last_started_at)}`;
          return (
            <button
              key={agent.agent_id}
              type="button"
              onClick={handleClick}
              disabled={isBusy && agent.active_session === null}
              className={`text-left rounded-md border border-zinc-800 border-l-4 ${state.accent} bg-zinc-900/60 hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed p-4 flex flex-col gap-2 transition-colors`}
            >
              <header className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${state.dot}`} aria-hidden />
                <span className="text-xs uppercase tracking-wider text-zinc-400">
                  {state.badge}
                </span>
                <span className="ml-auto font-mono text-xs text-zinc-500">
                  {agent.role.name}
                </span>
              </header>
              <h3 className="font-semibold text-zinc-100 truncate">
                {agent.label === null ? agent.role.name : agent.label}
              </h3>
              <p className="text-xs text-zinc-500">{lastActive}</p>
              <div className="mt-1 rounded bg-zinc-950/80 border border-zinc-800 p-2 text-xs text-zinc-400">
                {agent.office.latest === null ? (
                  <span className="italic text-zinc-600">
                    office is empty — no notes yet
                  </span>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-[10px] text-zinc-500 truncate">
                        {agent.office.latest.name}
                      </span>
                      <span className="ml-auto text-[10px] text-zinc-600 shrink-0">
                        {agent.office.file_count} note
                        {agent.office.file_count === 1 ? "" : "s"}
                      </span>
                    </div>
                    <pre className="whitespace-pre-wrap line-clamp-4 font-mono text-[11px] text-zinc-400">
                      {agent.office.latest.preview}
                    </pre>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
