import { describe, it, expect } from "bun:test";
import { layoutReducer, MIN_PANE_PX } from "../src/layout/reducer.ts";
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

describe("defaultLayout", () => {
  it("is a horizontal split of three panes with sizes [0.2, 0.55, 0.25]", () => {
    const root = asSplit(defaultLayout());
    expect(root.direction).toBe("h");
    expect(root.children).toHaveLength(3);
    expect(root.sizes).toEqual([0.2, 0.55, 0.25]);
    const a = asPane(root.children[0]);
    const b = asPane(root.children[1]);
    const c = asPane(root.children[2]);
    expect(a.views[0]?.kind).toBe("sessions");
    expect(b.views.map((v) => v.kind)).toEqual(["whiteboard"]);
    expect(c.views[0]?.kind).toBe("spawn");
    expect(a.activeIndex).toBe(0);
  });
});

// Several tests want a center pane with two tabs (mid was [mailbox, whiteboard]
// pre-#309). Build one by pinning a session into the default layout, yielding
// [whiteboard, mailbox#sess-1] in mid.
function withCenterPin(): LayoutNode {
  const mid = asPane(asSplit(defaultLayout()).children[1]!);
  return layoutReducer(defaultLayout(), {
    kind: "pin_mailbox",
    pane: mid.id,
    sessionId: "sess-1",
  });
}

describe("layoutReducer move_tab", () => {
  it("moves a tab across panes, removes from source, inserts at dropIndex in dest, and makes it active in dest", () => {
    const start = withCenterPin();
    const root = asSplit(start);
    const src = asPane(root.children[0]);
    const mid = asPane(root.children[1]);
    const next = asSplit(
      layoutReducer(start, {
        kind: "move_tab",
        from: src.id,
        to: mid.id,
        tabIndex: 0,
        dropIndex: 0,
      }),
    );
    const nSrc = asPane(next.children[0]);
    const nMid = asPane(next.children[1]);
    expect(nSrc.views).toHaveLength(0);
    expect(nSrc.activeIndex).toBeNull();
    expect(nMid.views.map((v) => v.kind)).toEqual([
      "sessions",
      "whiteboard",
      "mailbox",
    ]);
    expect(nMid.activeIndex).toBe(0);
  });

  it("reorders within the same pane", () => {
    const start = withCenterPin();
    const root = asSplit(start);
    const mid = asPane(root.children[1]!);
    const next = asSplit(
      layoutReducer(start, {
        kind: "move_tab",
        from: mid.id,
        to: mid.id,
        tabIndex: 0,
        dropIndex: 2,
      }),
    );
    const nMid = asPane(next.children[1]!);
    expect(nMid.views.map((v) => v.kind)).toEqual(["mailbox", "whiteboard"]);
  });
});

describe("layoutReducer select_tab", () => {
  it("sets activeIndex on the named pane", () => {
    const root = asSplit(defaultLayout());
    const mid = asPane(root.children[1]!);
    const next = asSplit(
      layoutReducer(defaultLayout(), {
        kind: "select_tab",
        pane: mid.id,
        index: 1,
      }),
    );
    expect(asPane(next.children[1]!).activeIndex).toBe(1);
  });
});

describe("layoutReducer resize", () => {
  it("applies new sizes when each pane stays >= MIN_PANE_PX", () => {
    const containerPx = 1000;
    const next = asSplit(
      layoutReducer(defaultLayout(), {
        kind: "resize",
        splitPath: [],
        sizes: [0.25, 0.5, 0.25],
        containerPx,
      }),
    );
    expect(next.sizes).toEqual([0.25, 0.5, 0.25]);
    for (const s of next.sizes) expect(s * containerPx).toBeGreaterThanOrEqual(MIN_PANE_PX);
  });

  it("clamps below-MIN sizes up to MIN_PANE_PX and renormalizes to sum 1", () => {
    const containerPx = 1000; // MIN fraction = 0.16
    const next = asSplit(
      layoutReducer(defaultLayout(), {
        kind: "resize",
        splitPath: [],
        sizes: [0.05, 0.75, 0.2],
        containerPx,
      }),
    );
    const sum = next.sizes.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    for (const s of next.sizes) {
      expect(s * containerPx).toBeGreaterThanOrEqual(MIN_PANE_PX - 1e-6);
    }
    expect(next.sizes[0]! * containerPx).toBeCloseTo(MIN_PANE_PX, 5);
  });
});

describe("layoutReducer split_pane", () => {
  it("splits the target pane vertically and places the dragged tab in a new sibling after the original", () => {
    const start = withCenterPin();
    const root = asSplit(start);
    const mid = asPane(root.children[1]!);
    const next = asSplit(
      layoutReducer(start, {
        kind: "split_pane",
        pane: mid.id,
        direction: "v",
        before: false,
        tab: { from: mid.id, index: 1 },
      }),
    );
    const inner = asSplit(next.children[1]!);
    expect(inner.direction).toBe("v");
    expect(inner.children).toHaveLength(2);
    expect(inner.sizes).toEqual([0.5, 0.5]);
    const original = asPane(inner.children[0]!);
    const created = asPane(inner.children[1]!);
    expect(original.id).toBe(mid.id);
    expect(original.views.map((v) => v.kind)).toEqual(["whiteboard"]);
    expect(created.views.map((v) => v.kind)).toEqual(["mailbox"]);
    expect(created.activeIndex).toBe(0);
    expect(created.id).not.toBe(mid.id);
  });

  it("with before:true places the new pane before the original (horizontal)", () => {
    const start = withCenterPin();
    const root = asSplit(start);
    const mid = asPane(root.children[1]!);
    const next = asSplit(
      layoutReducer(start, {
        kind: "split_pane",
        pane: mid.id,
        direction: "h",
        before: true,
        tab: { from: mid.id, index: 0 },
      }),
    );
    const inner = asSplit(next.children[1]!);
    expect(inner.direction).toBe("h");
    const first = asPane(inner.children[0]!);
    const second = asPane(inner.children[1]!);
    expect(first.views.map((v) => v.kind)).toEqual(["whiteboard"]);
    expect(second.id).toBe(mid.id);
    expect(second.views.map((v) => v.kind)).toEqual(["mailbox"]);
  });

  it("moves the tab from a different source pane into a new split sibling of the target", () => {
    const root = asSplit(defaultLayout());
    const src = asPane(root.children[0]!);
    const tgt = asPane(root.children[2]!);
    const next = asSplit(
      layoutReducer(defaultLayout(), {
        kind: "split_pane",
        pane: tgt.id,
        direction: "v",
        before: false,
        tab: { from: src.id, index: 0 },
      }),
    );
    const nSrc = asPane(next.children[0]!);
    expect(nSrc.views).toHaveLength(0);
    expect(nSrc.activeIndex).toBeNull();
    const inner = asSplit(next.children[2]!);
    expect(inner.direction).toBe("v");
    const created = asPane(inner.children[1]!);
    expect(created.views.map((v) => v.kind)).toEqual(["sessions"]);
  });
});

describe("layoutReducer resize on vertical split", () => {
  it("clamps below-MIN heights up to MIN_PANE_PX on a vertical split", () => {
    const start = withCenterPin();
    const mid = asPane(asSplit(start).children[1]!);
    const withSplit = layoutReducer(start, {
      kind: "split_pane",
      pane: mid.id,
      direction: "v",
      before: false,
      tab: { from: mid.id, index: 1 },
    });
    const containerPx = 1000;
    const next = asSplit(
      layoutReducer(withSplit, {
        kind: "resize",
        splitPath: [1],
        sizes: [0.05, 0.95],
        containerPx,
      }),
    );
    const inner = asSplit(next.children[1]!);
    for (const s of inner.sizes) {
      expect(s * containerPx).toBeGreaterThanOrEqual(MIN_PANE_PX - 1e-6);
    }
    expect(inner.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(inner.sizes[0]! * containerPx).toBeCloseTo(MIN_PANE_PX, 5);
  });
});

describe("layoutReducer reset", () => {
  it("returns the default layout shape", () => {
    const mutated = layoutReducer(defaultLayout(), {
      kind: "select_tab",
      pane: asPane(asSplit(defaultLayout()).children[1]!).id,
      index: 1,
    });
    const reset = asSplit(layoutReducer(mutated, { kind: "reset" }));
    expect(reset.sizes).toEqual([0.2, 0.55, 0.25]);
    expect(reset.children).toHaveLength(3);
  });
});
