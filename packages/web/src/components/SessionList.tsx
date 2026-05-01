import type { SessionSummary } from "../api.ts";

interface Props {
  readonly sessions: readonly SessionSummary[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
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
        return (
          <li key={s.session_id}>
            <button
              type="button"
              onClick={() => onSelect(s.session_id)}
              className={
                "w-full text-left px-4 py-3 hover:bg-zinc-900 transition-colors " +
                (isSelected ? "bg-zinc-900" : "")
              }
            >
              <div className="font-mono text-xs text-zinc-300 truncate">
                {s.session_id}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                  {s.last_event_name}
                </span>
                <span>{s.event_count} events</span>
                <span className="ml-auto">{relativeTime(s.last_seen_at)}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
