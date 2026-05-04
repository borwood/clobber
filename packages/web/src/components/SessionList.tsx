import { useState } from "react";
import type { SessionSummary } from "../api.ts";
import { STATE_DOT, pickTone } from "./state-tones.ts";

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
        const primary = s.label ?? s.session_id;
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
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px] uppercase tracking-wider shrink-0">
                  {s.role_name}
                </span>
                <div className="text-sm text-zinc-100 truncate font-medium">
                  {primary}
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
              {s.label !== undefined && (
                <div className="mt-1 font-mono text-[10px] text-zinc-600 truncate">
                  {s.session_id}
                </div>
              )}
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
