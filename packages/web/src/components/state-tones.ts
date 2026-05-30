import type { AgentState, SessionSummary } from "../api.ts";

export const STATE_DOT: Record<AgentState, string> = {
  working: "bg-working",
  blocked: "bg-blocked",
  done: "bg-done",
};

export interface CardTone {
  readonly base: string;
  readonly hover: string;
  readonly selected: string;
  readonly accent: string;
}

// Status cards tint their surface with the status hue (working = accent/emerald,
// blocked = provenance/amber) and mark the left edge with the crisp status
// token. Done uses the neutral surface ramp. A later theme (#369/#370) can
// diverge working/blocked from accent/provenance if it wants status cards to
// stop sharing the accent hue.
export const STATE_CARD: Record<AgentState, CardTone> = {
  working: {
    base: "bg-accent-deep/60",
    hover: "hover:bg-accent-muted/60",
    selected: "bg-accent-muted/70",
    accent: "border-l-working",
  },
  blocked: {
    base: "bg-provenance-deep/60",
    hover: "hover:bg-provenance-muted/60",
    selected: "bg-provenance-muted/70",
    accent: "border-l-blocked",
  },
  done: {
    base: "bg-surface/80",
    hover: "hover:bg-elevated",
    selected: "bg-elevated",
    accent: "border-l-done",
  },
};

export const NEUTRAL_CARD: CardTone = {
  base: "",
  hover: "hover:bg-surface",
  selected: "bg-surface",
  accent: "border-l-transparent",
};

export function pickTone(s: SessionSummary, isEnded: boolean): CardTone {
  if (isEnded) return NEUTRAL_CARD;
  if (s.latest_status === undefined) return NEUTRAL_CARD;
  return STATE_CARD[s.latest_status.state];
}
