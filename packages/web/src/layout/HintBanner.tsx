import { useState } from "react";

export const HINT_DISMISSED_KEY = "clobber:layout-hint-dismissed:v1";

const HINT_COPY =
  "Drag tabs between panes; both views can live side by side now.";

function initialDismissed(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(HINT_DISMISSED_KEY) === "1";
}

export function HintBanner() {
  const [dismissed, setDismissed] = useState<boolean>(initialDismissed);
  if (dismissed) return null;
  return (
    <div
      data-layout-hint="true"
      className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900/50 text-xs text-zinc-300"
    >
      <span className="flex-1">{HINT_COPY}</span>
      <button
        type="button"
        data-layout-hint-dismiss="true"
        onClick={() => {
          localStorage.setItem(HINT_DISMISSED_KEY, "1");
          setDismissed(true);
        }}
        className="px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500"
      >
        Got it
      </button>
    </div>
  );
}
