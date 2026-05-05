import type { AgentState, PersistentAgentCard } from "../api.ts";
import { relativeTime } from "./relative-time.ts";

interface WhiteboardViewProps {
  readonly agents: readonly PersistentAgentCard[];
  readonly now: number;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onWake: (agentId: string) => void;
  readonly busyAgentIds: ReadonlySet<string>;
}

interface IntentStyle {
  readonly label: string;
  readonly accent: string;
  readonly dot: string;
}

const INTENT_STYLES: Record<AgentState, IntentStyle> = {
  working: {
    label: "working",
    accent: "border-l-emerald-500",
    dot: "bg-emerald-500",
  },
  blocked: {
    label: "blocked",
    accent: "border-l-amber-500",
    dot: "bg-amber-500",
  },
  done: {
    label: "done",
    accent: "border-l-zinc-400",
    dot: "bg-zinc-400",
  },
};

const ASLEEP_STYLE = {
  accent: "border-l-zinc-700",
  dot: "bg-zinc-500",
} as const;

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
          const isWaking = busyAgentIds.has(agent.agent_id);
          const isAsleep = agent.active_session === null;
          const intentStyle =
            agent.active_session !== null && agent.active_session.latest_status !== null
              ? INTENT_STYLES[agent.active_session.latest_status.state]
              : null;
          const accent = isAsleep ? ASLEEP_STYLE.accent : intentStyle?.accent ?? "border-l-sky-500";

          const handleClick = () => {
            if (agent.active_session !== null) {
              onOpenSession(agent.active_session.id);
              return;
            }
            if (isWaking) return;
            onWake(agent.agent_id);
          };

          return (
            <button
              key={agent.agent_id}
              type="button"
              onClick={handleClick}
              disabled={isWaking && isAsleep}
              className={`text-left rounded-md border border-zinc-800 border-l-4 ${accent} bg-zinc-900/60 hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed p-4 flex flex-col gap-2 transition-colors`}
            >
              <header className="flex items-center gap-2">
                {isAsleep ? (
                  <>
                    <span className={`size-2 rounded-full ${ASLEEP_STYLE.dot}`} aria-hidden />
                    <span className="text-xs uppercase tracking-wider text-zinc-400">
                      asleep
                    </span>
                  </>
                ) : (
                  <ActivityDot
                    busy={agent.active_session!.busy}
                    intentDot={intentStyle?.dot ?? "bg-sky-500"}
                  />
                )}
                <span className="ml-auto font-mono text-xs text-zinc-500">
                  {agent.role.name}
                </span>
              </header>
              <h3 className="font-semibold text-zinc-100 truncate">
                {agent.label === null ? agent.role.name : agent.label}
              </h3>
              <SessionLine
                agent={agent}
                now={now}
                intentLabel={intentStyle?.label ?? null}
              />
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

interface ActivityDotProps {
  readonly busy: boolean;
  readonly intentDot: string;
}

function ActivityDot(props: ActivityDotProps) {
  const { busy, intentDot } = props;
  return (
    <span className="relative inline-flex size-2" aria-hidden>
      {busy && (
        <span
          className={`absolute inset-0 rounded-full ${intentDot} opacity-60 animate-ping`}
        />
      )}
      <span className={`relative size-2 rounded-full ${intentDot}`} />
    </span>
  );
}

interface SessionLineProps {
  readonly agent: PersistentAgentCard;
  readonly now: number;
  readonly intentLabel: string | null;
}

function SessionLine(props: SessionLineProps) {
  const { agent, now, intentLabel } = props;
  if (agent.active_session === null) {
    if (agent.last_started_at === null) {
      return <p className="text-xs text-zinc-500">never started</p>;
    }
    return (
      <p className="text-xs text-zinc-500">
        last awake {relativeTime(now, agent.last_started_at)}
      </p>
    );
  }
  const status = agent.active_session.latest_status;
  if (status === null) {
    return (
      <p className="text-xs text-zinc-500">
        started {relativeTime(now, agent.active_session.started_at)} — no status
      </p>
    );
  }
  return (
    <p className="text-xs text-zinc-300">
      {intentLabel !== null && (
        <span className="uppercase tracking-wider text-[10px] text-zinc-500 mr-2">
          {intentLabel}
        </span>
      )}
      <span className="text-zinc-200">{status.summary}</span>
    </p>
  );
}
