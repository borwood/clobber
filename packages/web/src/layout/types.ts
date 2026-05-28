export type ViewId =
  | { kind: "sessions" }
  | { kind: "spawn" }
  | { kind: "mailbox" }
  | { kind: "whiteboard" };

export interface PaneNode {
  readonly kind: "pane";
  readonly id: string;
  readonly views: readonly ViewId[];
  readonly activeIndex: number | null;
}

export interface SplitNode {
  readonly kind: "split";
  readonly direction: "h" | "v";
  readonly children: readonly LayoutNode[];
  readonly sizes: readonly number[];
}

export type LayoutNode = PaneNode | SplitNode;
