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
    expect(b.views.map((v) => v.kind)).toEqual(["mailbox", "whiteboard"]);
    expect(c.views[0]?.kind).toBe("spawn");
    expect(a.activeIndex).toBe(0);
  });
});

describe("layoutReducer move_tab", () => {
  it("moves a tab across panes, removes from source, inserts at dropIndex in dest, and makes it active in dest", () => {
    const root = asSplit(defaultLayout());
    const src = asPane(root.children[0]);
    const mid = asPane(root.children[1]);
    const next = asSplit(
      layoutReducer(defaultLayout(), {
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
      "mailbox",
      "whiteboard",
    ]);
    expect(nMid.activeIndex).toBe(0);
  });

  it("reorders within the same pane", () => {
    const root = asSplit(defaultLayout());
    const mid = asPane(root.children[1]!);
    const next = asSplit(
      layoutReducer(defaultLayout(), {
        kind: "move_tab",
        from: mid.id,
        to: mid.id,
        tabIndex: 0,
        dropIndex: 2,
      }),
    );
    const nMid = asPane(next.children[1]!);
    expect(nMid.views.map((v) => v.kind)).toEqual(["whiteboard", "mailbox"]);
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
