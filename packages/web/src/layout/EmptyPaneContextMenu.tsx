import { useEffect, useRef } from "react";
import { useLayout } from "./provider.tsx";
import { QUICK_ADDS } from "./empty-pane-quick-adds.ts";

interface Props {
  readonly paneId: string;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
}

export function EmptyPaneContextMenu({ paneId, x, y, onClose }: Props) {
  const { dispatch } = useLayout();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label="Open view"
      data-empty-pane-menu="true"
      style={{ position: "fixed", left: x, top: y }}
      className="z-30 w-40 rounded border border-border bg-bg shadow-lg py-1 text-sm"
    >
      {QUICK_ADDS.map((qa) => (
        <button
          key={qa.view.kind}
          type="button"
          role="menuitem"
          onClick={() => {
            dispatch({ kind: "open_view", pane: paneId, view: qa.view });
            onClose();
          }}
          className="w-full text-left px-3 py-1.5 text-text-soft hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-text-subtle"
        >
          {qa.label}
        </button>
      ))}
    </div>
  );
}
