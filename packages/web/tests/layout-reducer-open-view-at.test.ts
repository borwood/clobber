import { describe, it, expect } from "bun:test";
import { layoutReducer } from "../src/layout/reducer.ts";
import type { LayoutNode, PaneNode } from "../src/layout/types.ts";

function pane(id: string, views: PaneNode["views"]): PaneNode {
  return { kind: "pane", id, views, activeIndex: views.length > 0 ? 0 : null };
}

function asPane(n: LayoutNode): PaneNode {
  if (n.kind !== "pane") throw new Error("expected pane");
  return n;
}

describe("layoutReducer open_view_at (#318)", () => {
  const base = pane("p", [{ kind: "whiteboard" }, { kind: "spawn" }, { kind: "sessions" }]);

  it("inserts the view at the given index and focuses it", () => {
    const next = asPane(
      layoutReducer(base, {
        kind: "open_view_at",
        pane: "p",
        view: { kind: "mailbox", sessionId: "sess-1" },
        index: 1,
      }),
    );
    expect(next.views.map((v) => v.kind)).toEqual([
      "whiteboard",
      "mailbox",
      "spawn",
      "sessions",
    ]);
    expect(next.activeIndex).toBe(1);
  });

  it("inserts at the front when index is 0", () => {
    const next = asPane(
      layoutReducer(base, {
        kind: "open_view_at",
        pane: "p",
        view: { kind: "mailbox", sessionId: "sess-2" },
        index: 0,
      }),
    );
    expect(next.views[0]).toEqual({ kind: "mailbox", sessionId: "sess-2" });
    expect(next.activeIndex).toBe(0);
  });

  it("appends when index is at or past the end (clamped)", () => {
    const next = asPane(
      layoutReducer(base, {
        kind: "open_view_at",
        pane: "p",
        view: { kind: "spawn" },
        index: 99,
      }),
    );
    expect(next.views).toHaveLength(4);
    expect(next.views[3]).toEqual({ kind: "spawn" });
    expect(next.activeIndex).toBe(3);
  });
});
