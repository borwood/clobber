import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

type OpenInPane = (id: string, x: number, y: number) => void;

// Shared interactive spine for session cards — the session list and the
// whiteboard both ride it. Right-click a card to open a context menu offering
// "Open in pane…", which hands the session off to the layout's insert-drag
// flow. The hook owns the menu state + global dismiss (click / Escape /
// another right-click); the caller wires `openMenuAt` onto each card's
// onContextMenu and renders `menu` once.
export function useSessionCardMenu(onOpenInPane: OpenInPane | undefined): {
  readonly openMenuAt: (e: MouseEvent, sessionId: string) => void;
  readonly menu: ReactNode;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);

  useEffect(() => {
    if (menu === null) return;
    const dismiss = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss, { capture: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenuAt =
    onOpenInPane === undefined
      ? () => {}
      : (e: MouseEvent, sessionId: string) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, sessionId });
        };

  const element =
    menu !== null && onOpenInPane !== undefined ? (
      <div
        role="menu"
        className="fixed z-50 min-w-[14rem] rounded border border-border-strong bg-surface shadow-lg text-sm text-text"
        style={{ left: menu.x, top: menu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          className="w-full text-left px-3 py-2 hover:bg-elevated"
          onClick={() => {
            onOpenInPane(menu.sessionId, menu.x, menu.y);
            setMenu(null);
          }}
        >
          Open in pane…
        </button>
      </div>
    ) : null;

  return { openMenuAt, menu: element };
}
