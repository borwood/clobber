import type { LayoutNode } from "./types.ts";

// Remove the named pane. If its parent split is left with one child, the split
// unwraps to that child — recursively, so chains of single-child splits
// collapse in one pass. If the pane is the tree's only PaneNode, no-op (we
// never end up with zero panes). Sizes are dropped on unwrap; the surviving
// split keeps its sizes prorated to the remaining children.
export function closePane(state: LayoutNode, id: string): LayoutNode {
  if (state.kind === "pane") return state;
  if (!hasPane(state, id)) return state;
  const next = removePane(state, id);
  if (next === null) return state;
  return next;
}

function hasPane(node: LayoutNode, id: string): boolean {
  if (node.kind === "pane") return node.id === id;
  return node.children.some((c) => hasPane(c, id));
}

function removePane(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === "pane") return node.id === id ? null : node;
  const kept: LayoutNode[] = [];
  const keptSizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    const replaced = removePane(child, id);
    if (replaced === null) continue;
    kept.push(replaced);
    keptSizes.push(node.sizes[i] ?? 1 / node.children.length);
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  const sum = keptSizes.reduce((a, b) => a + b, 0);
  const sizes = sum > 0 ? keptSizes.map((s) => s / sum) : kept.map(() => 1 / kept.length);
  return { ...node, children: kept, sizes };
}
