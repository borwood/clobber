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
