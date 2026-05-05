import { useState } from "react";
import type { SessionSummary } from "../api.ts";
import { STATE_DOT, pickTone } from "./state-tones.ts";

interface Props {
  readonly session: SessionSummary;
}

export function SessionHeader({ session }: Props) {
  const isEnded = session.ended_at !== undefined;
  const tone = pickTone(session, isEnded);
  const status = session.latest_status;

  return (
    <div
      className={
        "flex items-center gap-3 px-6 py-3 border-l-4 " + tone.accent + " " + tone.base
      }
    >
      {status !== undefined && !isEnded && (
        <span
          className={
            "inline-block w-2.5 h-2.5 rounded-full shrink-0 " + STATE_DOT[status.state]
          }
          title={status.state}
        />
      )}
      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px] uppercase tracking-wider shrink-0">
        {session.role_name}
      </span>
      <RoleVersionBadge session={session} />
      {session.label !== undefined && (
        <span className="text-sm text-zinc-100 font-medium truncate">{session.label}</span>
      )}
      {status !== undefined && !isEnded && (
        <span className="text-xs text-zinc-300 truncate">{status.summary}</span>
      )}
      {isEnded && (
        <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 text-xs">ended</span>
      )}
      <CopyableId id={session.session_id} />
    </div>
  );
}

function RoleVersionBadge({ session }: { session: SessionSummary }) {
  const pinned = session.role_version;
  const current = session.role_current_version;
  if (pinned === undefined) return null;
  const stale = current !== undefined && current.id !== pinned.id;
  const tooltip = stale
    ? `pinned v${pinned.version} — current is v${current!.version}`
    : `pinned v${pinned.version}`;
  return (
    <span
      className={
        "px-1 py-0.5 rounded font-mono text-[10px] shrink-0 " +
        (stale ? "bg-amber-950 text-amber-300" : "bg-zinc-800 text-emerald-400")
      }
      title={tooltip}
    >
      v{pinned.version}
      {stale && <span className="ml-1 text-amber-400">→ v{current!.version}</span>}
    </span>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={copied ? "copied" : "click to copy"}
      className="ml-auto font-mono text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 px-2 py-1 rounded transition-colors shrink-0"
    >
      {copied ? "copied" : id}
    </button>
  );
}
