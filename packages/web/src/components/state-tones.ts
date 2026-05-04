import type { AgentState, SessionSummary } from "../api.ts";

export const STATE_DOT: Record<AgentState, string> = {
  working: "bg-emerald-500",
  blocked: "bg-amber-500",
  idle: "bg-sky-500",
  done: "bg-zinc-500",
};

export interface CardTone {
  readonly base: string;
  readonly hover: string;
  readonly selected: string;
  readonly accent: string;
}

export const STATE_CARD: Record<AgentState, CardTone> = {
  working: {
    base: "bg-emerald-950/60",
    hover: "hover:bg-emerald-900/60",
    selected: "bg-emerald-900/70",
    accent: "border-l-emerald-500",
  },
  blocked: {
    base: "bg-amber-950/60",
    hover: "hover:bg-amber-900/60",
    selected: "bg-amber-900/70",
    accent: "border-l-amber-500",
  },
  idle: {
    base: "bg-sky-950/60",
    hover: "hover:bg-sky-900/60",
    selected: "bg-sky-900/70",
    accent: "border-l-sky-500",
  },
  done: {
    base: "bg-zinc-900/80",
    hover: "hover:bg-zinc-800",
    selected: "bg-zinc-800",
    accent: "border-l-zinc-500",
  },
};

export const NEUTRAL_CARD: CardTone = {
  base: "",
  hover: "hover:bg-zinc-900",
  selected: "bg-zinc-900",
  accent: "border-l-transparent",
};

export function pickTone(s: SessionSummary, isEnded: boolean): CardTone {
  if (isEnded) return NEUTRAL_CARD;
  if (s.latest_status === undefined) return NEUTRAL_CARD;
  return STATE_CARD[s.latest_status.state];
}
