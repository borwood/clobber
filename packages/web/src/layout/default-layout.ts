import type { LayoutNode, PaneNode, SplitNode } from "./types.ts";

const pane = (id: string, views: PaneNode["views"]): PaneNode => ({
  kind: "pane",
  id,
  views,
  activeIndex: views.length > 0 ? 0 : null,
});

export function defaultLayout(): LayoutNode {
  const root: SplitNode = {
    kind: "split",
    direction: "h",
    sizes: [0.2, 0.55, 0.25],
    children: [
      pane("pane-sessions", [{ kind: "sessions" }]),
      pane("pane-center", [{ kind: "mailbox" }, { kind: "whiteboard" }]),
      pane("pane-spawn", [{ kind: "spawn" }]),
    ],
  };
  return root;
}
