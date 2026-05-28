import type { LayoutNode, PaneNode, SplitNode, ViewId } from "./types.ts";
import { defaultLayout } from "./default-layout.ts";
import { closePane } from "./close-pane.ts";

export const MIN_PANE_PX = 160;

export type Action =
  | { kind: "move_tab"; from: string; to: string; tabIndex: number; dropIndex: number }
  | { kind: "select_tab"; pane: string; index: number }
  | { kind: "resize"; splitPath: readonly number[]; sizes: readonly number[]; containerPx: number }
  | { kind: "open_view"; pane: string; view: ViewId }
  | { kind: "pin_mailbox"; pane: string; sessionId: string }
  | { kind: "close_tab"; pane: string; index: number }
  | { kind: "close_pane"; pane: string }
  | {
      kind: "split_pane";
      pane: string;
      direction: "h" | "v";
      before: boolean;
      // Drag-driven splits move a tab into the new pane. Button-driven splits
      // (per-pane split controls) omit `tab` to create an empty new pane.
      tab?: { from: string; index: number };
    }
  | { kind: "add_pane" }
  | { kind: "load_layout"; tree: LayoutNode }
  | { kind: "reopen_pane"; pane: PaneNode }
  | { kind: "reset" };

// The URL-focused mailbox singleton — `{ kind: "mailbox" }` with no
// sessionId — is uncloseable. Closing it would orphan URL focus, so close_tab
// is a no-op on this exact shape and Tabs hides the × on it.
export function isCloseable(view: ViewId): boolean {
  if (view.kind !== "mailbox") return true;
  return view.sessionId !== undefined;
}

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
    case "pin_mailbox":
      return mapPane(state, action.pane, (p) => ({
        ...p,
        views: [...p.views, { kind: "mailbox", sessionId: action.sessionId }],
        activeIndex: p.views.length,
      }));
    case "close_tab":
      return mapPane(state, action.pane, (p) => {
        const target = p.views[action.index];
        if (target === undefined || !isCloseable(target)) return p;
        const views = p.views.filter((_, i) => i !== action.index);
        const activeIndex =
          views.length === 0
            ? null
            : Math.max(0, Math.min(p.activeIndex ?? 0, views.length - 1));
        return { ...p, views, activeIndex };
      });
    case "close_pane":
      return closePane(state, action.pane);
    case "split_pane":
      return splitPane(state, action.pane, action.direction, action.before, action.tab);
    case "add_pane":
      return appendPane(state, emptyPane());
    case "load_layout":
      return action.tree;
    case "reopen_pane":
      return appendPane(state, action.pane);
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

function replacePane(
  node: LayoutNode,
  id: string,
  fn: (p: PaneNode) => LayoutNode,
): LayoutNode {
  if (node.kind === "pane") return node.id === id ? fn(node) : node;
  return {
    ...node,
    children: node.children.map((c) => replacePane(c, id, fn)),
  };
}

function newPaneId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `pane-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `pane-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyPane(): PaneNode {
  return { kind: "pane", id: newPaneId(), views: [], activeIndex: null };
}

function appendPane(state: LayoutNode, child: PaneNode): LayoutNode {
  if (state.kind === "pane") {
    return {
      kind: "split",
      direction: "h",
      children: [state, child],
      sizes: [0.5, 0.5],
    };
  }
  const n = state.children.length + 1;
  return {
    ...state,
    children: [...state.children, child],
    sizes: Array.from({ length: n }, () => 1 / n),
  };
}

function splitPane(
  state: LayoutNode,
  targetId: string,
  direction: "h" | "v",
  before: boolean,
  tab: { from: string; index: number } | undefined,
): LayoutNode {
  if (tab === undefined) {
    const created = emptyPane();
    return replacePane(state, targetId, (existing) => {
      const children = before ? [created, existing] : [existing, created];
      return { kind: "split", direction, children, sizes: [0.5, 0.5] };
    });
  }

  const sourcePane = findPane(state, tab.from);
  if (!sourcePane) throw new Error(`split_pane: source pane ${tab.from} not found`);
  const view = sourcePane.views[tab.index];
  if (!view) throw new Error(`split_pane: tabIndex ${tab.index} out of range`);

  const withoutSource = mapPane(state, tab.from, (p) => {
    const views = p.views.filter((_, i) => i !== tab.index);
    const activeIndex =
      views.length === 0
        ? null
        : Math.max(0, Math.min(p.activeIndex ?? 0, views.length - 1));
    return { ...p, views, activeIndex };
  });

  const created: PaneNode = {
    kind: "pane",
    id: newPaneId(),
    views: [view],
    activeIndex: 0,
  };

  return replacePane(withoutSource, targetId, (existing) => {
    const children = before ? [created, existing] : [existing, created];
    return { kind: "split", direction, children, sizes: [0.5, 0.5] };
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
