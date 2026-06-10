import type { AgentState, SessionSummary } from "../api.ts";

export interface StatusVisual {
  readonly label: string;
  readonly dot: string;
  readonly accent: string;
}

// THE canonical agent-state color set — the whiteboard's. Every surface that
// reflects agent state (whiteboard cards, session-list rows, the transcript
// header, tabs) derives its status dot + left-edge accent from here, so the
// hues can never drift between surfaces again. Single source per GR6.
export const STATUS_VISUAL: Record<AgentState, StatusVisual> = {
  working: { label: "working", dot: "bg-working", accent: "border-l-working" },
  blocked: { label: "blocked", dot: "bg-blocked", accent: "border-l-blocked" },
  done: { label: "done", dot: "bg-text-muted", accent: "border-l-text-muted" },
};

// Off-state edges of the same set: an agent with no active session (asleep), a
// session with no status yet, or an ended one.
export const STATUS_ASLEEP = { dot: "bg-done", accent: "border-l-border-strong" } as const;
export const STATUS_FALLBACK = { dot: "bg-info", accent: "border-l-info" } as const;

export interface CardTone {
  readonly base: string;
  readonly hover: string;
  readonly selected: string;
  readonly accent: string;
}

// Surfaces stay neutral (the whiteboard's visual language); agent state reads
// from the crisp left-edge accent + the status dot, never a colored surface
// wash. So every status-bearing surface looks the same as a whiteboard card.
const NEUTRAL_SURFACE = {
  base: "",
  hover: "hover:bg-surface",
  selected: "bg-elevated",
} as const;

export function pickTone(s: SessionSummary, isEnded: boolean): CardTone {
  const accent = isEnded
    ? "border-l-transparent"
    : s.latest_status === undefined
      ? STATUS_FALLBACK.accent
      : STATUS_VISUAL[s.latest_status.state].accent;
  return { ...NEUTRAL_SURFACE, accent };
}

export interface DotStyle {
  readonly dot: string;
  readonly busy: boolean;
  readonly hollow: boolean;
}

// Live activity dot for a session, used wherever a session surfaces (cards,
// rows, headers, tabs). Ended OR gone (no session) → hollow: a spent grey ring,
// never pinging, so a killed agent's tab dot empties out instead of going stale
// or vanishing. Running-but-no-status → neutral "alive" hue; otherwise the
// intent color + busy ping.
export function statusDot(s: SessionSummary | undefined): DotStyle {
  if (s === undefined || s.ended_at !== undefined) {
    return { dot: "", busy: false, hollow: true };
  }
  if (s.latest_status === undefined) {
    return { dot: STATUS_FALLBACK.dot, busy: s.busy === true, hollow: false };
  }
  return { dot: STATUS_VISUAL[s.latest_status.state].dot, busy: s.busy === true, hollow: false };
}
