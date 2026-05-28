import type { LayoutNode, PaneNode, ViewId } from "./types.ts";
import type { Action } from "./reducer.ts";

export interface ClosedRingCapture {
  readonly pane: PaneNode;
  readonly view: ViewId;
}

export function closedRingCaptureFor(
  prev: LayoutNode,
  action: Action,
): ClosedRingCapture | null {
  if (action.kind === "close_pane") {
    const pane = findPane(prev, action.pane);
    if (pane === null || pane.views.length === 0) return null;
    const view = pane.views[pane.activeIndex ?? 0] ?? pane.views[0]!;
    return { pane, view };
  }
  if (action.kind === "close_tab") {
    const pane = findPane(prev, action.pane);
    if (pane === null) return null;
    if (pane.views.length !== 1 || action.index !== 0) return null;
    return { pane, view: pane.views[0]! };
  }
  return null;
}

function findPane(node: LayoutNode, id: string): PaneNode | null {
  if (node.kind === "pane") return node.id === id ? node : null;
  for (const c of node.children) {
    const hit = findPane(c, id);
    if (hit !== null) return hit;
  }
  return null;
}
