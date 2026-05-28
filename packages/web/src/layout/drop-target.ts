import type { DropEdge } from "./PaneDropZones.tsx";

// Shared resolvers for pointer/click events landing on a pane's 5-zone drop
// overlay. Used by tab-drag (move-mode) and by insert-mode session opens.

export function paneIdFromEvent(e: { target: EventTarget | null; clientX: number; clientY: number }): string | null {
  const target = e.target;
  if (target instanceof Element) {
    const pane = target.closest<HTMLElement>('[data-pane="true"]');
    if (pane !== null) return pane.dataset.paneId ?? null;
  }
  if (typeof document === "undefined") return null;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el instanceof Element
    ? el.closest<HTMLElement>('[data-pane="true"]')?.dataset.paneId ?? null
    : null;
}

export function edgeFromEvent(e: { target: EventTarget | null; clientX: number; clientY: number }): DropEdge | null {
  const target = e.target;
  const fromTarget =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-drop-edge]")
      : null;
  if (fromTarget !== null) {
    return (fromTarget.dataset.dropEdge as DropEdge) ?? null;
  }
  if (typeof document === "undefined") return null;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!(el instanceof Element)) return null;
  const zone = el.closest<HTMLElement>("[data-drop-edge]");
  return zone === null ? null : (zone.dataset.dropEdge as DropEdge) ?? null;
}

function tabRects(paneId: string): DOMRect[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-pane-id="${paneId}"] [role="tab"]`),
  ).map((t) => t.getBoundingClientRect());
}

// Cursor-X → insertion index within a pane's tab strip. Shared by tab-drag
// (move_tab), insert-mode (open_view_at), and the strip's insertion caret —
// one math, three consumers.
export function computeDropIndex(paneId: string, clientX: number): number {
  if (typeof document === "undefined") return 0;
  const rects = tabRects(paneId);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (clientX < r.left + r.width / 2) return i;
  }
  return rects.length;
}

// Pane-relative X of the gap that `computeDropIndex` would insert before, used
// to position the strip's insertion caret over the same boundary the drop dispatches to.
export function dropCaretX(paneId: string, clientX: number): number {
  if (typeof document === "undefined") return 0;
  const rects = tabRects(paneId);
  if (rects.length === 0) return 0;
  const pane = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`)!;
  const paneLeft = pane.getBoundingClientRect().left;
  const index = computeDropIndex(paneId, clientX);
  const boundary = index < rects.length ? rects[index]!.left : rects[rects.length - 1]!.right;
  return boundary - paneLeft;
}
