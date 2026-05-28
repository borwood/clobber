import type { LayoutNode, PaneNode } from "./types.ts";

export function findPaneById(node: LayoutNode, id: string): PaneNode | null {
  if (node.kind === "pane") return node.id === id ? node : null;
  for (const c of node.children) {
    const hit = findPaneById(c, id);
    if (hit !== null) return hit;
  }
  return null;
}
