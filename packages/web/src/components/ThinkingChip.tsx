import { useEffect, useState } from "react";

interface Props {
  readonly startMs: number | null;
}

// Small transient indicator — mirrors the native `claude` CLI's animated
// thinking widget. Shown only when claude has written a thinking-only
// assistant line and nothing has landed after it yet (see
// shouldHideThinkingPulse). Ticks the second-counter while mounted and
// stops automatically when the parent stops rendering it.
export function ThinkingChip({ startMs }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSec =
    startMs === null ? null : Math.max(0, Math.floor((now - startMs) / 1000));

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 italic px-3 py-1">
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      <span>
        thinking{elapsedSec === null ? "" : ` · ${elapsedSec}s`}
      </span>
    </div>
  );
}
