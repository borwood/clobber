import { useEffect, useState } from "react";
import { formatElapsed, formatTokens, type WorkingState } from "../working-state.ts";

interface Props {
  readonly state: WorkingState;
}

// Sticky footer status line shown while the agent's turn is in flight —
// mirrors the native `claude` CLI's animated working widget:
// `● Clobbering… | 1m 42s | 2.2k tokens`. Ticks its own second-counter while
// mounted; verb and token count refresh as the polled transcript grows.
export function WorkingIndicator({ state }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSec =
    state.startMs === null ? null : Math.max(0, Math.floor((now - state.startMs) / 1000));

  return (
    <div className="shrink-0 flex items-center gap-2 border-t border-border px-6 py-1.5 text-xs font-mono text-text-muted">
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-working opacity-75 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-working" />
      </span>
      <span className="text-accent-text">{state.verb}…</span>
      {elapsedSec !== null && (
        <>
          <Sep />
          <span>{formatElapsed(elapsedSec)}</span>
        </>
      )}
      {state.outputTokens > 0 && (
        <>
          <Sep />
          <span>{formatTokens(state.outputTokens)} tokens</span>
        </>
      )}
    </div>
  );
}

function Sep() {
  return <span className="text-border-strong select-none">|</span>;
}
