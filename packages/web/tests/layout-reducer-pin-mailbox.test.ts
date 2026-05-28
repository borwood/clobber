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

describe("layoutReducer pin_mailbox", () => {
  it("appends { kind:'mailbox', sessionId } to the target pane's views and makes it active", () => {
    const mid = asPane(asSplit(defaultLayout()).children[1]!);
    const next = asSplit(
      layoutReducer(defaultLayout(), {
        kind: "pin_mailbox",
        pane: mid.id,
        sessionId: "sess-abc",
      }),
    );
    const nMid = asPane(next.children[1]!);
    expect(nMid.views).toHaveLength(2);
    expect(nMid.views[1]).toEqual({ kind: "mailbox", sessionId: "sess-abc" });
    expect(nMid.activeIndex).toBe(1);
  });

  it("allows pinning the same session twice (each is its own tab)", () => {
    const mid = asPane(asSplit(defaultLayout()).children[1]!);
    const once = layoutReducer(defaultLayout(), {
      kind: "pin_mailbox",
      pane: mid.id,
      sessionId: "sess-1",
    });
    const twice = asSplit(
      layoutReducer(once, {
        kind: "pin_mailbox",
        pane: mid.id,
        sessionId: "sess-1",
      }),
    );
    const nMid = asPane(twice.children[1]!);
    expect(nMid.views).toHaveLength(3);
    expect(nMid.views[2]).toEqual({ kind: "mailbox", sessionId: "sess-1" });
  });
});

describe("layoutReducer close_tab", () => {
  it("removes the view at the given index and clears activeIndex when empty", () => {
    const mid = asPane(asSplit(defaultLayout()).children[1]!);
    // mid is [whiteboard]; close it
    const next = asSplit(
      layoutReducer(defaultLayout(), {
        kind: "close_tab",
        pane: mid.id,
        index: 0,
      }),
    );
    const nMid = asPane(next.children[1]!);
    expect(nMid.views).toEqual([]);
    expect(nMid.activeIndex).toBeNull();
  });

  it("closes a pinned mailbox tab", () => {
    const mid = asPane(asSplit(defaultLayout()).children[1]!);
    const withPin = layoutReducer(defaultLayout(), {
      kind: "pin_mailbox",
      pane: mid.id,
      sessionId: "sess-1",
    });
    // mid now is [whiteboard, mailbox#sess-1]
    const closed = asSplit(
      layoutReducer(withPin, {
        kind: "close_tab",
        pane: mid.id,
        index: 1,
      }),
    );
    const nMid = asPane(closed.children[1]!);
    expect(nMid.views.map((v) => v.kind)).toEqual(["whiteboard"]);
    expect(nMid.activeIndex).toBe(0);
  });

  it("clamps activeIndex when removing the active tab at the end of the list", () => {
    const mid = asPane(asSplit(defaultLayout()).children[1]!);
    const withPin = layoutReducer(defaultLayout(), {
      kind: "pin_mailbox",
      pane: mid.id,
      sessionId: "sess-1",
    });
    // After pin: views = [whiteboard, mailbox], activeIndex = 1. Close index 1.
    const closed = asSplit(
      layoutReducer(withPin, { kind: "close_tab", pane: mid.id, index: 1 }),
    );
    const nMid = asPane(closed.children[1]!);
    expect(nMid.activeIndex).toBe(0);
  });
});
