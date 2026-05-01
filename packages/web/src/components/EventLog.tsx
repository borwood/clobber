import type { StoredEvent } from "../api.ts";

interface Props {
  readonly events: readonly StoredEvent[];
}

const EVENT_COLORS: Record<string, string> = {
  SessionStart: "bg-emerald-900 text-emerald-200",
  SessionEnd: "bg-rose-900 text-rose-200",
  UserPromptSubmit: "bg-sky-900 text-sky-200",
  PreToolUse: "bg-amber-900 text-amber-200",
  PostToolUse: "bg-amber-900/60 text-amber-200",
  Notification: "bg-violet-900 text-violet-200",
  Stop: "bg-zinc-800 text-zinc-300",
  PreCompact: "bg-zinc-800 text-zinc-300",
};

function colorFor(name: string): string {
  const hit = EVENT_COLORS[name];
  return hit === undefined ? "bg-zinc-800 text-zinc-300" : hit;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function EventLog({ events }: Props) {
  if (events.length === 0) {
    return <div className="text-sm text-zinc-500">No events yet.</div>;
  }

  return (
    <ol className="space-y-1 font-mono text-sm">
      {events.map((ev) => {
        const name = ev.payload.hook_event_name;
        const tool =
          "tool_name" in ev.payload && typeof ev.payload.tool_name === "string"
            ? ev.payload.tool_name
            : null;
        return (
          <li
            key={ev.id}
            className="flex items-baseline gap-3 px-3 py-1.5 rounded hover:bg-zinc-900"
          >
            <span className="text-zinc-600 text-xs w-20 shrink-0">
              {formatTime(ev.received_at)}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded ${colorFor(name)} shrink-0`}
            >
              {name}
            </span>
            {tool !== null && <span className="text-zinc-400 text-xs">{tool}</span>}
          </li>
        );
      })}
    </ol>
  );
}
