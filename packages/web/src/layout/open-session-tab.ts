import type { LayoutNode, PaneNode } from "./types.ts";

// 4-step routing: focus existing tab → empty pane → pane-with-mailbox →
// originating pane. The single point of truth for "where does a session tab
// go?", reused by SessionList clicks and deep-link cold-load auto-pin.
export function openSessionTab(
  state: LayoutNode,
  sessionId: string,
  originatingPaneId: string,
): LayoutNode {
  const panes: PaneNode[] = [];
  collectPanes(state, panes);

  for (const p of panes) {
    const idx = p.views.findIndex(
      (v) => v.kind === "mailbox" && v.sessionId === sessionId,
    );
    if (idx !== -1) {
      return mapPane(state, p.id, (pp) => ({ ...pp, activeIndex: idx }));
    }
  }

  const empty = panes.find((p) => p.views.length === 0);
  if (empty !== undefined) return pinMailboxTo(state, empty.id, sessionId);

  const withMailbox = panes.find((p) => p.views.some((v) => v.kind === "mailbox"));
  if (withMailbox !== undefined) return pinMailboxTo(state, withMailbox.id, sessionId);

  return pinMailboxTo(state, originatingPaneId, sessionId);
}

function pinMailboxTo(state: LayoutNode, paneId: string, sessionId: string): LayoutNode {
  return mapPane(state, paneId, (p) => ({
    ...p,
    views: [...p.views, { kind: "mailbox", sessionId }],
    activeIndex: p.views.length,
  }));
}

function mapPane(
  node: LayoutNode,
  id: string,
  fn: (p: PaneNode) => PaneNode,
): LayoutNode {
  if (node.kind === "pane") return node.id === id ? fn(node) : node;
  return { ...node, children: node.children.map((c) => mapPane(c, id, fn)) };
}

function collectPanes(node: LayoutNode, out: PaneNode[]): void {
  if (node.kind === "pane") {
    out.push(node);
    return;
  }
  for (const c of node.children) collectPanes(c, out);
}
