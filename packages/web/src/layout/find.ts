import type { LayoutNode, PaneNode, ViewId } from "./types.ts";

export function findPaneById(node: LayoutNode, id: string): PaneNode | null {
  if (node.kind === "pane") return node.id === id ? node : null;
  for (const c of node.children) {
    const hit = findPaneById(c, id);
    if (hit !== null) return hit;
  }
  return null;
}

// Whether any pane anywhere in the tree currently has a tab of this view
// kind — used by the reopen-closed-panel-type affordance (LayoutMenu) to
// decide which singleton panel types are "closed" (absent, not just
// backgrounded behind another tab).
export function layoutHasViewKind(node: LayoutNode, kind: ViewId["kind"]): boolean {
  if (node.kind === "pane") return node.views.some((v) => v.kind === kind);
  return node.children.some((c) => layoutHasViewKind(c, kind));
}
