import { useState, type MouseEvent } from "react";
import type { DeskCard, OfficeCard, SessionView } from "../api.ts";
import { relativeTime } from "./relative-time.ts";
import { ActivityDot } from "./ActivityDot.tsx";
import {
  STATUS_VISUAL,
  STATUS_ASLEEP,
  STATUS_FALLBACK,
  type StatusVisual,
} from "./state-tones.ts";

function intentStyleFor(session: SessionView): StatusVisual | null {
  if (session.latest_status === null) return null;
  return STATUS_VISUAL[session.latest_status.state];
}

interface OfficeCardViewProps {
  readonly office: OfficeCard;
  readonly now: number;
  readonly isWaking: boolean;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onContextMenu: ((e: MouseEvent) => void) | undefined;
  readonly onWake: (agentId: string, wakeProgram: string) => void;
}

export function OfficeCardView(props: OfficeCardViewProps) {
  const { office, now, isWaking, onOpenSession, onContextMenu, onWake } = props;
  const isAsleep = office.active_session === null;
  const intentStyle =
    office.active_session === null ? null : intentStyleFor(office.active_session);
  const accent = isAsleep
    ? STATUS_ASLEEP.accent
    : intentStyle === null
      ? STATUS_FALLBACK.accent
      : intentStyle.accent;

  const className = `text-left rounded-md border border-border border-l-4 ${accent} bg-surface/60 p-4 flex flex-col gap-2 transition-colors`;

  const header = (
    <>
      <header className="flex items-center gap-2">
        {isAsleep ? (
          <>
            <span className={`size-2 rounded-full ${STATUS_ASLEEP.dot}`} aria-hidden />
            <span className="text-xs uppercase tracking-wider text-text-muted">
              asleep
            </span>
          </>
        ) : (
          <ActivityDot
            busy={office.active_session!.busy}
            intentDot={intentStyle === null ? STATUS_FALLBACK.dot : intentStyle.dot}
          />
        )}
        <span className="ml-auto font-mono text-xs text-text-subtle">
          {office.role.name}
        </span>
      </header>
      <h3 className="font-semibold text-text truncate">
        {office.label === null ? office.role.name : office.label}
      </h3>
      <OfficeSessionLine
        office={office}
        now={now}
        intentLabel={intentStyle === null ? null : intentStyle.label}
      />
      <OfficeNotesPreview office={office} />
    </>
  );

  // Asleep: a wake-program selector + an explicit Wake button (the human picks
  // the opening move, default `idle`). Active: the whole card opens the session.
  if (isAsleep) {
    return (
      <div className={className}>
        {header}
        <OfficeWakeControl
          office={office}
          isWaking={isWaking}
          onWake={onWake}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenSession(office.active_session!.id)}
      onContextMenu={onContextMenu}
      className={`${className} hover:bg-surface`}
    >
      {header}
    </button>
  );
}

interface OfficeWakeControlProps {
  readonly office: OfficeCard;
  readonly isWaking: boolean;
  readonly onWake: (agentId: string, wakeProgram: string) => void;
}

function OfficeWakeControl(props: OfficeWakeControlProps) {
  const { office, isWaking, onWake } = props;
  // The route defaults to `idle`; the offered list leads with it.
  const [selected, setSelected] = useState(office.wake_programs[0] ?? "idle");

  return (
    <div className="mt-1 flex items-center gap-2">
      <select
        value={selected}
        disabled={isWaking}
        onChange={(e) => setSelected(e.target.value)}
        className="flex-1 rounded border border-border-strong bg-bg px-2 py-1 text-xs text-text-dim disabled:opacity-50"
      >
        {office.wake_programs.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={isWaking}
        onClick={() => onWake(office.agent_id, selected)}
        className="rounded bg-info-strong hover:bg-info disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1 text-xs font-medium text-white transition-colors"
      >
        {isWaking ? "waking…" : "Wake"}
      </button>
    </div>
  );
}

function OfficeNotesPreview(props: { readonly office: OfficeCard }) {
  const { office } = props;
  return (
    <div className="mt-1 rounded bg-bg/80 border border-border p-2 text-xs text-text-muted">
      {office.office.latest === null ? (
        <span className="italic text-text-faint">
          office is empty — no notes yet
        </span>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[10px] text-text-subtle truncate">
              {office.office.latest.name}
            </span>
            <span className="ml-auto text-[10px] text-text-faint shrink-0">
              {office.office.file_count} note
              {office.office.file_count === 1 ? "" : "s"}
            </span>
          </div>
          <pre className="whitespace-pre-wrap line-clamp-4 font-mono text-[11px] text-text-muted">
            {office.office.latest.preview}
          </pre>
        </>
      )}
    </div>
  );
}

interface DeskCardViewProps {
  readonly desk: DeskCard;
  readonly now: number;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onContextMenu: (e: MouseEvent) => void;
}

export function DeskCardView(props: DeskCardViewProps) {
  const { desk, now, onOpenSession, onContextMenu } = props;
  const intentStyle = intentStyleFor(desk.session);
  const accent = intentStyle === null ? STATUS_FALLBACK.accent : intentStyle.accent;
  const dot = intentStyle === null ? STATUS_FALLBACK.dot : intentStyle.dot;

  return (
    <button
      type="button"
      onClick={() => onOpenSession(desk.session.id)}
      onContextMenu={onContextMenu}
      className={`text-left rounded-md border border-border border-l-4 ${accent} bg-surface/40 hover:bg-surface p-3 flex flex-col gap-1.5 transition-colors`}
    >
      <header className="flex items-center gap-2">
        <ActivityDot busy={desk.session.busy} intentDot={dot} />
        <span className="ml-auto font-mono text-xs text-text-subtle">
          {desk.role.name}
        </span>
      </header>
      <h3 className="font-semibold text-text truncate">
        {desk.label === null ? desk.role.name : desk.label}
      </h3>
      <SessionStatusLine
        session={desk.session}
        now={now}
        intentLabel={intentStyle === null ? null : intentStyle.label}
      />
    </button>
  );
}

interface OfficeSessionLineProps {
  readonly office: OfficeCard;
  readonly now: number;
  readonly intentLabel: string | null;
}

function OfficeSessionLine(props: OfficeSessionLineProps) {
  const { office, now, intentLabel } = props;
  if (office.active_session === null) {
    if (office.last_started_at === null) {
      return <p className="text-xs text-text-subtle">never started</p>;
    }
    return (
      <p className="text-xs text-text-subtle">
        last awake {relativeTime(now, office.last_started_at)}
      </p>
    );
  }
  return (
    <SessionStatusLine
      session={office.active_session}
      now={now}
      intentLabel={intentLabel}
    />
  );
}

interface SessionStatusLineProps {
  readonly session: SessionView;
  readonly now: number;
  readonly intentLabel: string | null;
}

function SessionStatusLine(props: SessionStatusLineProps) {
  const { session, now, intentLabel } = props;
  if (session.latest_status === null) {
    return (
      <p className="text-xs text-text-subtle">
        started {relativeTime(now, session.started_at)} — no status
      </p>
    );
  }
  return (
    <p className="text-xs text-text-soft">
      {intentLabel !== null && (
        <span className="uppercase tracking-wider text-[10px] text-text-subtle mr-2">
          {intentLabel}
        </span>
      )}
      <span className="text-text-dim">{session.latest_status.summary}</span>
    </p>
  );
}
