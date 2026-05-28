import type { LayoutNode, PaneNode, ViewId } from "./types.ts";
import { defaultLayout } from "./default-layout.ts";
import { closePane } from "./close-pane.ts";
import { openSessionTab } from "./open-session-tab.ts";
import { applyResize } from "./resize.ts";

export const MIN_PANE_PX = 160;

export type Action =
  | { kind: "move_tab"; from: string; to: string; tabIndex: number; dropIndex: number }
  | { kind: "select_tab"; pane: string; index: number }
  | { kind: "resize"; splitPath: readonly number[]; sizes: readonly number[]; containerPx: number }
  | { kind: "open_view"; pane: string; view: ViewId }
  | { kind: "open_view_at"; pane: string; view: ViewId; index: number }
  | { kind: "pin_mailbox"; pane: string; sessionId: string }
  | { kind: "open_session_tab"; sessionId: string; originatingPaneId: string }
  | { kind: "close_tab"; pane: string; index: number }
  | { kind: "close_pane"; pane: string }
  | {
      kind: "split_pane";
      pane: string;
      direction: "h" | "v";
      before: boolean;
      // Drag-driven splits migrate a tab from a source pane; insert-mode
      // (#316) drops a fresh view into the new pane; button-driven splits
      // omit `tab` entirely.
      tab?: { from: string; index: number } | { view: ViewId };
    }
  | { kind: "add_pane" }
  | { kind: "load_layout"; tree: LayoutNode }
  | { kind: "reopen_pane"; pane: PaneNode }
  | { kind: "reset" };

export function layoutReducer(state: LayoutNode, action: Action): LayoutNode {
  switch (action.kind) {
    case "move_tab":
      return moveTab(state, action.from, action.to, action.tabIndex, action.dropIndex);
    case "select_tab":
      return mapPane(state, action.pane, (p) => ({ ...p, activeIndex: action.index }));
    case "resize":
      return applyResize(state, action.splitPath, action.sizes, action.containerPx, MIN_PANE_PX);
    case "open_view":
      return mapPane(state, action.pane, (p) => ({
        ...p,
        views: [...p.views, action.view],
        activeIndex: p.views.length,
      }));
    case "open_view_at":
      return mapPane(state, action.pane, (p) => {
        const views = [...p.views];
        const clamped = Math.max(0, Math.min(action.index, views.length));
        views.splice(clamped, 0, action.view);
        return { ...p, views, activeIndex: clamped };
      });
    case "pin_mailbox":
      return mapPane(state, action.pane, (p) => ({
        ...p,
        views: [...p.views, { kind: "mailbox", sessionId: action.sessionId }],
        activeIndex: p.views.length,
      }));
    case "open_session_tab":
      return openSessionTab(state, action.sessionId, action.originatingPaneId);
    case "close_tab":
      return mapPane(state, action.pane, (p) => {
        if (p.views[action.index] === undefined) return p;
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
  tab: { from: string; index: number } | { view: ViewId } | undefined,
): LayoutNode {
  if (tab === undefined) {
    const created = emptyPane();
    return replacePane(state, targetId, (existing) => {
      const children = before ? [created, existing] : [existing, created];
      return { kind: "split", direction, children, sizes: [0.5, 0.5] };
    });
  }

  if ("view" in tab) {
    const created: PaneNode = {
      kind: "pane",
      id: newPaneId(),
      views: [tab.view],
      activeIndex: 0,
    };
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
