import { describe, it, expect } from "bun:test";
import { layoutReducer } from "../src/layout/reducer.ts";
import { defaultLayout } from "../src/layout/default-layout.ts";
import type { LayoutNode, PaneNode, SplitNode } from "../src/layout/types.ts";

function asSplit(n: LayoutNode | undefined): SplitNode {
  if (!n || n.kind !== "split") throw new Error("expected split");
  return n;
}
function asPane(n: LayoutNode | undefined): PaneNode {
  if (!n || n.kind !== "pane") throw new Error("expected pane");
  return n;
}

describe("layoutReducer split_pane with view (#316)", () => {
  it("creates a new pane to the right with the supplied view as its sole tab", () => {
    const root = asSplit(defaultLayout());
    const mid = asPane(root.children[1]);
    const next = layoutReducer(defaultLayout(), {
      kind: "split_pane",
      pane: mid.id,
      direction: "h",
      before: false,
      tab: { view: { kind: "mailbox", sessionId: "sess-1" } },
    });
    // mid is replaced by a nested h-split [mid, created]
    const outer = asSplit(next);
    const inner = asSplit(outer.children[1]);
    expect(inner.direction).toBe("h");
    const existing = asPane(inner.children[0]);
    const created = asPane(inner.children[1]);
    expect(existing.views.map((v) => v.kind)).toEqual(["whiteboard"]);
    expect(created.views).toHaveLength(1);
    expect(created.views[0]).toEqual({ kind: "mailbox", sessionId: "sess-1" });
    expect(created.activeIndex).toBe(0);
  });

  it("does not remove or mutate any other pane (the view is not migrated from anywhere)", () => {
    const before = defaultLayout();
    const root = asSplit(before);
    const mid = asPane(root.children[1]);
    const after = asSplit(
      layoutReducer(before, {
        kind: "split_pane",
        pane: mid.id,
        direction: "v",
        before: true,
        tab: { view: { kind: "spawn" } },
      }),
    );
    // left and right untouched
    expect(after.children[0]).toEqual(root.children[0]);
    expect(after.children[2]).toEqual(root.children[2]);
  });
});
