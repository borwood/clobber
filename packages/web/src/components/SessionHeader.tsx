import { useState } from "react";
import type { SessionSummary } from "../api.ts";
import { statusDot } from "./state-tones.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { CwdLine } from "./CwdLine.tsx";

interface Props {
  readonly session: SessionSummary;
}

export function SessionHeader({ session }: Props) {
  const isEnded = session.ended_at !== undefined;
  const status = session.latest_status;
  const showSummary = status !== undefined && !isEnded;
  const dot = statusDot(session);

  return (
    <div className="relative overflow-hidden border-b border-border px-6 py-3">
      <div className="flex items-start gap-3">
        <span className="shrink-0 flex" title={status?.state}>
          <AgentAvatar
            label={session.label === undefined ? session.role_name : session.label}
            role={session.role_name}
            statusBg={dot.hollow ? "bg-text-faint" : dot.dot}
            busy={dot.busy}
            muted={dot.hollow}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {session.label !== undefined && (
              <span className="text-sm text-text font-medium break-words">
                {session.label}
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded bg-elevated text-text-soft text-[10px] uppercase tracking-wider">
              {session.role_name}
            </span>
            <RoleVersionBadge session={session} />
            <ModelEffortBadges session={session} />
            {isEnded && (
              <span className="px-1.5 py-0.5 rounded bg-elevated text-text-subtle text-xs">
                ended
              </span>
            )}
            <CopyableId id={session.session_id} />
          </div>
          {showSummary && (
            <div className="mt-1 text-xs text-text-soft break-words">
              {status.summary}
            </div>
          )}
          {session.cwd !== undefined && <CwdLine cwd={session.cwd} />}
        </div>
      </div>
    </div>
  );
}

function ModelEffortBadges({ session }: { session: SessionSummary }) {
  if (session.model === undefined && session.effort === undefined) return null;
  return (
    <>
      {session.model !== undefined && (
        <span className="px-1.5 py-0.5 rounded bg-elevated text-text-soft text-[10px] font-mono shrink-0">
          {session.model}
        </span>
      )}
      {session.effort !== undefined && (
        <span className="px-1.5 py-0.5 rounded bg-elevated text-text-soft text-[10px] font-mono shrink-0">
          {session.effort}
        </span>
      )}
    </>
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
        (stale ? "bg-provenance-deep text-provenance-text" : "bg-elevated text-accent-text")
      }
      title={tooltip}
    >
      v{pinned.version}
      {stale && <span className="ml-1 text-provenance-text">→ v{current!.version}</span>}
    </span>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const short = id.slice(0, 8);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={copied ? "copied" : `${id} — click to copy`}
      className="ml-auto font-mono text-[10px] text-text-subtle hover:text-text-soft hover:bg-elevated px-2 py-1 rounded transition-colors shrink-0"
    >
      {copied ? "copied" : short}
    </button>
  );
}
