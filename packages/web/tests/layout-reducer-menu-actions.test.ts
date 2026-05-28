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

describe("layoutReducer add_pane", () => {
  it("appends an empty pane as the last child of the root split", () => {
    const before = asSplit(defaultLayout());
    const after = asSplit(layoutReducer(defaultLayout(), { kind: "add_pane" }));
    expect(after.children).toHaveLength(before.children.length + 1);
    const created = asPane(after.children[after.children.length - 1]!);
    expect(created.views).toHaveLength(0);
    expect(created.activeIndex).toBeNull();
    expect(after.sizes).toHaveLength(after.children.length);
    const sum = after.sizes.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("wraps a degenerate root-pane tree in a horizontal split with the new pane", () => {
    const single: PaneNode = {
      kind: "pane",
      id: "only",
      views: [{ kind: "spawn" }],
      activeIndex: 0,
    };
    const after = asSplit(layoutReducer(single, { kind: "add_pane" }));
    expect(after.direction).toBe("h");
    expect(after.children).toHaveLength(2);
    expect(asPane(after.children[0]!).id).toBe("only");
    expect(asPane(after.children[1]!).views).toHaveLength(0);
    expect(after.sizes).toEqual([0.5, 0.5]);
  });
});

describe("layoutReducer load_layout", () => {
  it("replaces the current tree with the provided snapshot", () => {
    const snap: PaneNode = {
      kind: "pane",
      id: "snap",
      views: [{ kind: "whiteboard" }],
      activeIndex: 0,
    };
    const after = layoutReducer(defaultLayout(), { kind: "load_layout", tree: snap });
    expect(after).toEqual(snap);
  });
});

describe("layoutReducer reopen_pane", () => {
  it("appends the supplied pane to the root split", () => {
    const reopened: PaneNode = {
      kind: "pane",
      id: "reopened",
      views: [{ kind: "whiteboard" }],
      activeIndex: 0,
    };
    const after = asSplit(
      layoutReducer(defaultLayout(), { kind: "reopen_pane", pane: reopened }),
    );
    const last = asPane(after.children[after.children.length - 1]!);
    expect(last.id).toBe("reopened");
    expect(last.views).toEqual([{ kind: "whiteboard" }]);
  });

  it("wraps a degenerate root-pane tree alongside the reopened pane", () => {
    const single: PaneNode = {
      kind: "pane",
      id: "only",
      views: [{ kind: "spawn" }],
      activeIndex: 0,
    };
    const reopened: PaneNode = {
      kind: "pane",
      id: "back",
      views: [{ kind: "sessions" }],
      activeIndex: 0,
    };
    const after = asSplit(layoutReducer(single, { kind: "reopen_pane", pane: reopened }));
    expect(after.direction).toBe("h");
    expect(after.children).toHaveLength(2);
    expect(asPane(after.children[1]!).id).toBe("back");
  });
});
