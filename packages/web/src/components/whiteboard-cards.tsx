import { useState } from "react";
import type { AgentState, DeskCard, OfficeCard, SessionView } from "../api.ts";
import { relativeTime } from "./relative-time.ts";

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

const FALLBACK_ACCENT = "border-l-sky-500";
const FALLBACK_DOT = "bg-sky-500";

function intentStyleFor(session: SessionView): IntentStyle | null {
  if (session.latest_status === null) return null;
  return INTENT_STYLES[session.latest_status.state];
}

interface OfficeCardViewProps {
  readonly office: OfficeCard;
  readonly now: number;
  readonly isWaking: boolean;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onWake: (agentId: string, wakeProgram: string) => void;
}

export function OfficeCardView(props: OfficeCardViewProps) {
  const { office, now, isWaking, onOpenSession, onWake } = props;
  const isAsleep = office.active_session === null;
  const intentStyle =
    office.active_session === null ? null : intentStyleFor(office.active_session);
  const accent = isAsleep
    ? ASLEEP_STYLE.accent
    : intentStyle === null
      ? FALLBACK_ACCENT
      : intentStyle.accent;

  const className = `text-left rounded-md border border-zinc-800 border-l-4 ${accent} bg-zinc-900/60 p-4 flex flex-col gap-2 transition-colors`;

  const header = (
    <>
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
            busy={office.active_session!.busy}
            intentDot={intentStyle === null ? FALLBACK_DOT : intentStyle.dot}
          />
        )}
        <span className="ml-auto font-mono text-xs text-zinc-500">
          {office.role.name}
        </span>
      </header>
      <h3 className="font-semibold text-zinc-100 truncate">
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
      className={`${className} hover:bg-zinc-900`}
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
        className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 disabled:opacity-50"
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
        className="rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1 text-xs font-medium text-white transition-colors"
      >
        {isWaking ? "waking…" : "Wake"}
      </button>
    </div>
  );
}

function OfficeNotesPreview(props: { readonly office: OfficeCard }) {
  const { office } = props;
  return (
    <div className="mt-1 rounded bg-zinc-950/80 border border-zinc-800 p-2 text-xs text-zinc-400">
      {office.office.latest === null ? (
        <span className="italic text-zinc-600">
          office is empty — no notes yet
        </span>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[10px] text-zinc-500 truncate">
              {office.office.latest.name}
            </span>
            <span className="ml-auto text-[10px] text-zinc-600 shrink-0">
              {office.office.file_count} note
              {office.office.file_count === 1 ? "" : "s"}
            </span>
          </div>
          <pre className="whitespace-pre-wrap line-clamp-4 font-mono text-[11px] text-zinc-400">
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
}

export function DeskCardView(props: DeskCardViewProps) {
  const { desk, now, onOpenSession } = props;
  const intentStyle = intentStyleFor(desk.session);
  const accent = intentStyle === null ? FALLBACK_ACCENT : intentStyle.accent;
  const dot = intentStyle === null ? FALLBACK_DOT : intentStyle.dot;

  return (
    <button
      type="button"
      onClick={() => onOpenSession(desk.session.id)}
      className={`text-left rounded-md border border-zinc-800 border-l-4 ${accent} bg-zinc-900/40 hover:bg-zinc-900 p-3 flex flex-col gap-1.5 transition-colors`}
    >
      <header className="flex items-center gap-2">
        <ActivityDot busy={desk.session.busy} intentDot={dot} />
        <span className="ml-auto font-mono text-xs text-zinc-500">
          {desk.role.name}
        </span>
      </header>
      <h3 className="font-semibold text-zinc-100 truncate">
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

interface OfficeSessionLineProps {
  readonly office: OfficeCard;
  readonly now: number;
  readonly intentLabel: string | null;
}

function OfficeSessionLine(props: OfficeSessionLineProps) {
  const { office, now, intentLabel } = props;
  if (office.active_session === null) {
    if (office.last_started_at === null) {
      return <p className="text-xs text-zinc-500">never started</p>;
    }
    return (
      <p className="text-xs text-zinc-500">
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
      <p className="text-xs text-zinc-500">
        started {relativeTime(now, session.started_at)} — no status
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
      <span className="text-zinc-200">{session.latest_status.summary}</span>
    </p>
  );
}
