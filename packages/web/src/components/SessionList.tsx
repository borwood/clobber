import { useState } from "react";
import type { AgentState, SessionSummary } from "../api.ts";

interface Props {
  readonly sessions: readonly SessionSummary[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onEnd: (id: string) => Promise<void>;
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

const STATE_DOT: Record<AgentState, string> = {
  working: "bg-emerald-500",
  blocked: "bg-amber-500",
  idle: "bg-sky-500",
  done: "bg-zinc-500",
};

interface CardTone {
  readonly base: string;
  readonly hover: string;
  readonly selected: string;
  readonly accent: string;
}

const STATE_CARD: Record<AgentState, CardTone> = {
  working: {
    base: "bg-emerald-950/60",
    hover: "hover:bg-emerald-900/60",
    selected: "bg-emerald-900/70",
    accent: "border-l-emerald-500",
  },
  blocked: {
    base: "bg-amber-950/60",
    hover: "hover:bg-amber-900/60",
    selected: "bg-amber-900/70",
    accent: "border-l-amber-500",
  },
  idle: {
    base: "bg-sky-950/60",
    hover: "hover:bg-sky-900/60",
    selected: "bg-sky-900/70",
    accent: "border-l-sky-500",
  },
  done: {
    base: "bg-zinc-900/80",
    hover: "hover:bg-zinc-800",
    selected: "bg-zinc-800",
    accent: "border-l-zinc-500",
  },
};

const NEUTRAL_CARD: CardTone = {
  base: "",
  hover: "hover:bg-zinc-900",
  selected: "bg-zinc-900",
  accent: "border-l-transparent",
};

function pickTone(s: SessionSummary, isEnded: boolean): CardTone {
  if (isEnded) return NEUTRAL_CARD;
  if (s.latest_status === undefined) return NEUTRAL_CARD;
  return STATE_CARD[s.latest_status.state];
}

export function SessionList({ sessions, selectedId, onSelect, onEnd }: Props) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);

  if (sessions.length === 0) {
    return (
      <div className="p-4 text-sm text-zinc-500">
        No sessions yet. Spawn one →
      </div>
    );
  }

  return (
    <ul className="divide-y divide-zinc-800">
      {sessions.map((s) => {
        const isSelected = s.session_id === selectedId;
        const isEnded = s.ended_at !== undefined;
        const isConfirming = confirmingId === s.session_id;
        const isEnding = endingId === s.session_id;
        const tone = pickTone(s, isEnded);
        return (
          <li key={s.session_id} className="relative">
            <button
              type="button"
              onClick={() => onSelect(s.session_id)}
              className={
                "w-full text-left px-4 py-3 pr-10 border-l-4 transition-colors " +
                tone.accent +
                " " +
                (isSelected ? tone.selected : tone.base + " " + tone.hover)
              }
            >
              <div className="flex items-center gap-2">
                {s.latest_status !== undefined && !isEnded && (
                  <span
                    className={
                      "inline-block w-2 h-2 rounded-full shrink-0 " +
                      STATE_DOT[s.latest_status.state]
                    }
                    title={s.latest_status.state}
                  />
                )}
                <div className="font-mono text-xs text-zinc-300 truncate">
                  {s.session_id}
                </div>
              </div>
              {s.latest_status !== undefined && !isEnded && (
                <div className="mt-1 text-xs text-zinc-300 truncate">
                  {s.latest_status.summary}
                </div>
              )}
              <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                {isEnded ? (
                  <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">
                    ended
                  </span>
                ) : s.last_event_name === undefined ? (
                  <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 italic">
                    no events yet
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                    {s.last_event_name}
                  </span>
                )}
                <span>{s.event_count} events</span>
                <span className="ml-auto">{relativeTime(s.last_seen_at)}</span>
              </div>
            </button>

            {!isEnded && !isConfirming && (
              <button
                type="button"
                aria-label="End session"
                title="End session"
                disabled={isEnding}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingId(s.session_id);
                }}
                className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                ✕
              </button>
            )}

            {isConfirming && (
              <div
                className="absolute inset-0 flex items-center justify-end gap-2 px-4 bg-zinc-950/95 backdrop-blur-sm"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-xs text-zinc-300 mr-auto">End this session?</span>
                <button
                  type="button"
                  onClick={() => setConfirmingId(null)}
                  className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setEndingId(s.session_id);
                    setConfirmingId(null);
                    try {
                      await onEnd(s.session_id);
                    } finally {
                      setEndingId(null);
                    }
                  }}
                  className="px-2 py-1 text-xs rounded bg-red-700 text-white hover:bg-red-600"
                >
                  End
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
