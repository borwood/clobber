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

describe("layoutReducer close_pane", () => {
  it("removes one child of a 3-child split, leaving the split with 2 children", () => {
    const root = asSplit(defaultLayout());
    const left = asPane(root.children[0]);
    const next = asSplit(
      layoutReducer(defaultLayout(), { kind: "close_pane", pane: left.id }),
    );
    expect(next.children).toHaveLength(2);
    const ids = next.children.map((c) => (c.kind === "pane" ? c.id : "split"));
    expect(ids).not.toContain(left.id);
    expect(next.sizes).toHaveLength(2);
  });

  it("collapses a single-child split: parent split is replaced by its remaining child", () => {
    // Build a nested split via split_pane, then close one side. The inner split
    // should collapse, leaving a single pane in that branch.
    const root = asSplit(defaultLayout());
    const mid = asPane(root.children[1]!);
    const seeded = layoutReducer(defaultLayout(), {
      kind: "pin_mailbox",
      pane: mid.id,
      sessionId: "sess-1",
    });
    const withInner = layoutReducer(seeded, {
      kind: "split_pane",
      pane: mid.id,
      direction: "v",
      before: false,
      tab: { from: mid.id, index: 1 },
    });
    const inner = asSplit(asSplit(withInner).children[1]!);
    const created = asPane(inner.children[1]!);
    const closed = asSplit(
      layoutReducer(withInner, { kind: "close_pane", pane: created.id }),
    );
    // The slot that previously held the inner split should now be a pane
    // (the original mid pane), since the split unwrapped to its sole child.
    const middleSlot = closed.children[1]!;
    expect(middleSlot.kind).toBe("pane");
    expect(asPane(middleSlot).id).toBe(mid.id);
  });

  it("cascading collapse: nested single-child splits unwrap up the tree", () => {
    // Three-level structure: root[mid] is a vertical split with [A, B];
    // A is itself a horizontal split with [X, Y]. Closing Y unwraps inner split
    // to X; if we then close B, the outer (now single-child) split unwraps to X.
    const root = asSplit(defaultLayout());
    const mid = asPane(root.children[1]!);
    // Split mid vertically (creates a new sibling next to mid)
    const seeded = layoutReducer(defaultLayout(), {
      kind: "pin_mailbox",
      pane: mid.id,
      sessionId: "sess-1",
    });
    const s1 = layoutReducer(seeded, {
      kind: "split_pane",
      pane: mid.id,
      direction: "v",
      before: false,
      tab: { from: mid.id, index: 1 },
    });
    const inner1 = asSplit(asSplit(s1).children[1]!);
    const A = asPane(inner1.children[0]!); // == mid id
    const B = asPane(inner1.children[1]!);
    // Split A horizontally — first add a view to A so it has a tab to split out
    const s2a = layoutReducer(s1, {
      kind: "open_view",
      pane: A.id,
      view: { kind: "spawn" },
    });
    const s2 = layoutReducer(s2a, {
      kind: "split_pane",
      pane: A.id,
      direction: "h",
      before: false,
      tab: { from: A.id, index: 1 },
    });
    // Locate A's inner split children
    const outer = asSplit(asSplit(s2).children[1]!);
    const innerAA = asSplit(outer.children[0]!);
    const X = asPane(innerAA.children[0]!);
    const Y = asPane(innerAA.children[1]!);

    // Close Y -> inner H-split collapses to X
    const afterY = layoutReducer(s2, { kind: "close_pane", pane: Y.id });
    // Close B -> outer V-split (now single child) collapses to X
    const afterB = layoutReducer(afterY, { kind: "close_pane", pane: B.id });
    const finalRoot = asSplit(afterB);
    expect(finalRoot.children[1]!.kind).toBe("pane");
    expect(asPane(finalRoot.children[1]!).id).toBe(X.id);
  });

  it("root-pane no-op: if the tree is just one pane, close_pane is a no-op", () => {
    // Reduce to a single-pane tree by closing 2 of the 3 root children.
    const root = asSplit(defaultLayout());
    const left = asPane(root.children[0]!);
    const right = asPane(root.children[2]!);
    const s1 = layoutReducer(defaultLayout(), { kind: "close_pane", pane: left.id });
    const s2 = layoutReducer(s1, { kind: "close_pane", pane: right.id });
    // s2 should now be a single pane (root collapsed)
    expect(s2.kind).toBe("pane");
    const onlyPane = asPane(s2);
    const s3 = layoutReducer(s2, { kind: "close_pane", pane: onlyPane.id });
    expect(s3).toBe(s2);
  });

  it("no-op on unknown pane id", () => {
    const before = defaultLayout();
    const after = layoutReducer(before, { kind: "close_pane", pane: "no-such-pane" });
    expect(after).toBe(before);
  });
});
