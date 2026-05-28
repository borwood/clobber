import { describe, it, expect } from "bun:test";
import { layoutReducer } from "../src/layout/reducer.ts";
import type { LayoutNode, PaneNode, SplitNode } from "../src/layout/types.ts";

function pane(id: string, views: PaneNode["views"]): PaneNode {
  return {
    kind: "pane",
    id,
    views,
    activeIndex: views.length > 0 ? 0 : null,
  };
}

function hSplit(children: LayoutNode[]): SplitNode {
  const n = children.length;
  return {
    kind: "split",
    direction: "h",
    children,
    sizes: Array.from({ length: n }, () => 1 / n),
  };
}

function asSplit(n: LayoutNode | undefined): SplitNode {
  if (!n || n.kind !== "split") throw new Error("expected split");
  return n;
}
function asPane(n: LayoutNode | undefined): PaneNode {
  if (!n || n.kind !== "pane") throw new Error("expected pane");
  return n;
}

describe("layoutReducer open_session_tab — 4-step routing rule", () => {
  it("step 1: focuses an existing mailbox tab for the same sessionId (no new tab)", () => {
    const layout = hSplit([
      pane("origin", [{ kind: "sessions" }]),
      pane("host", [
        { kind: "whiteboard" },
        { kind: "mailbox", sessionId: "sess-X" },
      ]),
    ]);
    const next = asSplit(
      layoutReducer(layout, {
        kind: "open_session_tab",
        sessionId: "sess-X",
        originatingPaneId: "origin",
      }),
    );
    const host = asPane(next.children[1]!);
    expect(host.views).toHaveLength(2);
    expect(host.activeIndex).toBe(1);
  });

  it("step 2: empty pane wins over a pane-with-mailbox", () => {
    const layout = hSplit([
      pane("origin", [{ kind: "sessions" }]),
      pane("mbox", [{ kind: "mailbox", sessionId: "other" }]),
      pane("empty", []),
    ]);
    const next = asSplit(
      layoutReducer(layout, {
        kind: "open_session_tab",
        sessionId: "sess-new",
        originatingPaneId: "origin",
      }),
    );
    const empty = asPane(next.children[2]!);
    expect(empty.views).toEqual([{ kind: "mailbox", sessionId: "sess-new" }]);
    expect(empty.activeIndex).toBe(0);
    const mbox = asPane(next.children[1]!);
    expect(mbox.views).toHaveLength(1);
  });

  it("step 3: pane-with-mailbox wins over originating pane", () => {
    const layout = hSplit([
      pane("origin", [{ kind: "sessions" }]),
      pane("mbox", [{ kind: "mailbox", sessionId: "other" }]),
    ]);
    const next = asSplit(
      layoutReducer(layout, {
        kind: "open_session_tab",
        sessionId: "sess-new",
        originatingPaneId: "origin",
      }),
    );
    const mbox = asPane(next.children[1]!);
    expect(mbox.views).toHaveLength(2);
    expect(mbox.views[1]).toEqual({ kind: "mailbox", sessionId: "sess-new" });
    expect(mbox.activeIndex).toBe(1);
    const origin = asPane(next.children[0]!);
    expect(origin.views).toHaveLength(1);
  });

  it("step 4: falls back to the originating pane when no empty + no mailbox pane", () => {
    const layout = hSplit([
      pane("origin", [{ kind: "sessions" }]),
      pane("other", [{ kind: "whiteboard" }]),
    ]);
    const next = asSplit(
      layoutReducer(layout, {
        kind: "open_session_tab",
        sessionId: "sess-new",
        originatingPaneId: "origin",
      }),
    );
    const origin = asPane(next.children[0]!);
    expect(origin.views).toHaveLength(2);
    expect(origin.views[1]).toEqual({ kind: "mailbox", sessionId: "sess-new" });
    expect(origin.activeIndex).toBe(1);
  });

  it("step 4 with root-pane originating: degenerate root pane gets the tab", () => {
    const root: PaneNode = pane("root", [{ kind: "sessions" }]);
    const next = asPane(
      layoutReducer(root, {
        kind: "open_session_tab",
        sessionId: "sess-Y",
        originatingPaneId: "root",
      }),
    );
    expect(next.views).toHaveLength(2);
    expect(next.views[1]).toEqual({ kind: "mailbox", sessionId: "sess-Y" });
    expect(next.activeIndex).toBe(1);
  });
});
