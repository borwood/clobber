import { useState } from "react";
import type { OpenQuestion, SessionSummary } from "../api.ts";
import { pickTone, statusDot } from "./state-tones.ts";
import { ActivityDot } from "./ActivityDot.tsx";
import { useSessionCardMenu } from "./useSessionCardMenu.tsx";

function openQuestionLabel(q: OpenQuestion): string {
  const first = q.questions[0]!.question;
  const extra = q.questions.length - 1;
  return extra > 0 ? `${first} (+${extra} more)` : first;
}

interface Props {
  readonly sessions: readonly SessionSummary[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onEnd: (id: string) => Promise<void>;
  readonly onResume: (id: string) => Promise<void>;
  readonly onOpenInPane?: ((id: string, x: number, y: number) => void) | undefined;
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

export function SessionList({ sessions, selectedId, onSelect, onEnd, onResume, onOpenInPane }: Props) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const { openMenuAt, menu } = useSessionCardMenu(onOpenInPane);

  if (sessions.length === 0) {
    return (
      <div className="p-4 text-sm text-text-subtle">
        No sessions yet. Spawn one →
      </div>
    );
  }

  return (
    <>
    {menu}
    <ul className="divide-y divide-border">
      {sessions.map((s) => {
        const isSelected = s.session_id === selectedId;
        const isEnded = s.ended_at !== undefined;
        const isConfirming = confirmingId === s.session_id;
        const isEnding = endingId === s.session_id;
        const isResuming = resumingId === s.session_id;
        const wasLive = s.was_live_at_shutdown === true;
        const tone = pickTone(s, isEnded);
        const primary = s.label ?? s.session_id;
        return (
          <li
            key={s.session_id}
            className="relative"
            onContextMenu={(e) => openMenuAt(e, s.session_id)}
          >
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
                {s.open_question !== undefined && !isEnded && (
                  <span
                    className="inline-block px-1 rounded bg-provenance-strong text-provenance-fg text-[10px] font-bold shrink-0 animate-pulse"
                    title="Waiting for an answer"
                  >
                    ?
                  </span>
                )}
                {!isEnded &&
                  (() => {
                    const d = statusDot(s);
                    return (
                      <span className="shrink-0" title={s.latest_status?.state}>
                        <ActivityDot busy={d.busy} intentDot={d.dot} hollow={d.hollow} />
                      </span>
                    );
                  })()}
                <span className="px-1.5 py-0.5 rounded bg-elevated text-text-soft text-[10px] uppercase tracking-wider shrink-0">
                  {s.role_name}
                </span>
                <div className="text-sm text-text truncate font-medium">
                  {primary}
                </div>
              </div>
              {s.open_question !== undefined && !isEnded && (
                <div className="mt-1 text-xs text-provenance-text truncate italic">
                  {openQuestionLabel(s.open_question)}
                </div>
              )}
              {s.latest_status !== undefined && !isEnded && (
                <div className="mt-1 text-xs text-text-soft truncate">
                  {s.latest_status.summary}
                </div>
              )}
              <div className="mt-1 flex items-center gap-2 text-xs text-text-subtle">
                {wasLive && (
                  <span
                    className="px-1.5 py-0.5 rounded bg-info-surface text-info-fg"
                    title="Running when clobber last closed — resume to pick up unfinished business"
                  >
                    was live
                  </span>
                )}
                {isEnded && (
                  <span className="px-1.5 py-0.5 rounded bg-elevated text-text-subtle">
                    ended
                  </span>
                )}
                {s.context_tokens !== undefined && (
                  <span className="font-mono">
                    ~{Math.round(s.context_tokens / 1000)}k ctx
                  </span>
                )}
                <span className="ml-auto">{relativeTime(s.last_seen_at)}</span>
              </div>
            </button>

            {isEnded && (
              <button
                type="button"
                aria-label="Resume session"
                title="Resume session"
                disabled={isResuming}
                onClick={async (e) => {
                  e.stopPropagation();
                  setResumingId(s.session_id);
                  try {
                    await onResume(s.session_id);
                  } finally {
                    setResumingId(null);
                  }
                }}
                className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded text-text-subtle hover:text-info-text hover:bg-elevated transition-colors disabled:opacity-50"
              >
                ↻
              </button>
            )}

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
                className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded text-text-subtle hover:text-danger-text hover:bg-elevated transition-colors disabled:opacity-50"
              >
                ✕
              </button>
            )}

            {isConfirming && (
              <div
                className="absolute inset-0 flex items-center justify-end gap-2 px-4 bg-bg/95 backdrop-blur-sm"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-xs text-text-soft mr-auto">End this session?</span>
                <button
                  type="button"
                  onClick={() => setConfirmingId(null)}
                  className="px-2 py-1 text-xs rounded bg-elevated text-text-soft hover:bg-raised"
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
                  className="px-2 py-1 text-xs rounded bg-danger-strong text-white hover:bg-danger-strong"
                >
                  End
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
    </>
  );
}
