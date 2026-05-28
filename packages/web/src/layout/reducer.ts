import type { LayoutNode, PaneNode, SplitNode, ViewId } from "./types.ts";
import { defaultLayout } from "./default-layout.ts";

export const MIN_PANE_PX = 160;

export type Action =
  | { kind: "move_tab"; from: string; to: string; tabIndex: number; dropIndex: number }
  | { kind: "select_tab"; pane: string; index: number }
  | { kind: "resize"; splitPath: readonly number[]; sizes: readonly number[]; containerPx: number }
  | { kind: "open_view"; pane: string; view: ViewId }
  | { kind: "reset" };

export function layoutReducer(state: LayoutNode, action: Action): LayoutNode {
  switch (action.kind) {
    case "move_tab":
      return moveTab(state, action.from, action.to, action.tabIndex, action.dropIndex);
    case "select_tab":
      return mapPane(state, action.pane, (p) => ({ ...p, activeIndex: action.index }));
    case "resize":
      return applyResize(state, action.splitPath, action.sizes, action.containerPx);
    case "open_view":
      return mapPane(state, action.pane, (p) => ({
        ...p,
        views: [...p.views, action.view],
        activeIndex: p.views.length,
      }));
    case "reset":
      return defaultLayout();
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function mapPane(
  node: LayoutNode,
  id: string,
  fn: (p: PaneNode) => PaneNode,
): LayoutNode {
  if (node.kind === "pane") return node.id === id ? fn(node) : node;
  return {
    ...node,
    children: node.children.map((c) => mapPane(c, id, fn)),
  };
}

function findPane(node: LayoutNode, id: string): PaneNode | null {
  if (node.kind === "pane") return node.id === id ? node : null;
  for (const c of node.children) {
    const hit = findPane(c, id);
    if (hit) return hit;
  }
  return null;
}

function moveTab(
  state: LayoutNode,
  fromId: string,
  toId: string,
  tabIndex: number,
  dropIndex: number,
): LayoutNode {
  const fromPane = findPane(state, fromId);
  if (!fromPane) throw new Error(`move_tab: source pane ${fromId} not found`);
  const view = fromPane.views[tabIndex];
  if (!view) throw new Error(`move_tab: tabIndex ${tabIndex} out of range`);

  if (fromId === toId) {
    const reordered = [...fromPane.views];
    reordered.splice(tabIndex, 1);
    const clamped = Math.max(0, Math.min(dropIndex, reordered.length));
    reordered.splice(clamped, 0, view);
    return mapPane(state, fromId, (p) => ({
      ...p,
      views: reordered,
      activeIndex: clamped,
    }));
  }

  const withoutSource = mapPane(state, fromId, (p) => {
    const views = p.views.filter((_, i) => i !== tabIndex);
    const activeIndex =
      views.length === 0
        ? null
        : Math.max(0, Math.min(p.activeIndex ?? 0, views.length - 1));
    return { ...p, views, activeIndex };
  });
  return mapPane(withoutSource, toId, (p) => {
    const views = [...p.views];
    const clamped = Math.max(0, Math.min(dropIndex, views.length));
    views.splice(clamped, 0, view);
    return { ...p, views, activeIndex: clamped };
  });
}

function applyResize(
  state: LayoutNode,
  path: readonly number[],
  sizes: readonly number[],
  containerPx: number,
): LayoutNode {
  return updateSplit(state, path, 0, (split) => {
    if (sizes.length !== split.children.length) {
      throw new Error(
        `resize: size count ${sizes.length} ≠ children count ${split.children.length}`,
      );
    }
    return { ...split, sizes: clampSizes(sizes, MIN_PANE_PX / containerPx) };
  });
}

function updateSplit(
  node: LayoutNode,
  path: readonly number[],
  depth: number,
  fn: (s: SplitNode) => SplitNode,
): LayoutNode {
  if (depth === path.length) {
    if (node.kind !== "split") throw new Error("resize: path does not point to a split");
    return fn(node);
  }
  if (node.kind !== "split") throw new Error("resize: path descends through a pane");
  const idx = path[depth]!;
  return {
    ...node,
    children: node.children.map((c, i) =>
      i === idx ? updateSplit(c, path, depth + 1, fn) : c,
    ),
  };
}

function clampSizes(input: readonly number[], minFrac: number): number[] {
  if (input.length * minFrac > 1 + 1e-9) {
    return input.map(() => 1 / input.length);
  }
  let out = input.slice();
  for (let iter = 0; iter < 16; iter++) {
    const below = out.map((s) => s < minFrac - 1e-12);
    if (!below.some(Boolean)) break;
    const deficit = out.reduce((d, s, i) => (below[i] ? d + (minFrac - s) : d), 0);
    const headroom = out.reduce(
      (t, s, i) => (!below[i] ? t + (s - minFrac) : t),
      0,
    );
    if (headroom <= 0) return input.map(() => 1 / input.length);
    out = out.map((s, i) =>
      below[i] ? minFrac : s - (s - minFrac) * (deficit / headroom),
    );
  }
  const sum = out.reduce((a, b) => a + b, 0);
  return out.map((s) => s / sum);
}
