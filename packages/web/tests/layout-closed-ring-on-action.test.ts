import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { closedRingCaptureFor } from "../src/layout/closed-ring-capture.ts";
import { layoutReducer } from "../src/layout/reducer.ts";
import {
  pushClosedPane,
  listClosedPanes,
  CLOSED_RING_SIZE,
} from "../src/layout/persistence.ts";
import { viewLabel } from "../src/layout/ViewHost.tsx";
import type { LayoutNode, PaneNode } from "../src/layout/types.ts";

const SLUG = "acme";

function singlePane(views: PaneNode["views"]): LayoutNode {
  return {
    kind: "pane",
    id: "p-root",
    views,
    activeIndex: views.length === 0 ? null : 0,
  };
}

function rootSplitWith(left: PaneNode, right: PaneNode): LayoutNode {
  return {
    kind: "split",
    direction: "h",
    children: [left, right],
    sizes: [0.5, 0.5],
  };
}

function capture(slug: string, prev: LayoutNode, action: Parameters<typeof closedRingCaptureFor>[1]): void {
  const cap = closedRingCaptureFor(prev, action);
  if (cap === null) return;
  pushClosedPane(slug, cap.pane, viewLabel(cap.view), Date.now());
}

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("closed-ring capture on dispatch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("close_tab on a non-last view does NOT push", () => {
    const prev = singlePane([{ kind: "sessions" }, { kind: "spawn" }]);
    capture(SLUG, prev, { kind: "close_tab", pane: "p-root", index: 0 });
    expect(listClosedPanes(SLUG)).toHaveLength(0);
  });

  it("close_tab on the last (only) view pushes a closed-ring entry with the view's label", () => {
    const prev = singlePane([{ kind: "sessions" }]);
    capture(SLUG, prev, { kind: "close_tab", pane: "p-root", index: 0 });
    const entries = listClosedPanes(SLUG);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe("Sessions");
    expect(entries[0]!.pane.id).toBe("p-root");
    expect(entries[0]!.pane.views).toEqual([{ kind: "sessions" }]);
  });

  it("the captured pane shape can be restored via reopen_pane and brings the view back", () => {
    const prev = singlePane([{ kind: "spawn" }]);
    capture(SLUG, prev, { kind: "close_tab", pane: "p-root", index: 0 });
    const afterClose = layoutReducer(prev, {
      kind: "close_tab",
      pane: "p-root",
      index: 0,
    });
    const entry = listClosedPanes(SLUG)[0]!;
    const restored = layoutReducer(afterClose, {
      kind: "reopen_pane",
      pane: entry.pane,
    });
    // After reopen, somewhere in the tree we have a pane containing the spawn view.
    expect(JSON.stringify(restored)).toContain('"kind":"spawn"');
  });

  it("close_pane still pushes (regression)", () => {
    const left: PaneNode = {
      kind: "pane",
      id: "p-left",
      views: [{ kind: "whiteboard" }],
      activeIndex: 0,
    };
    const right: PaneNode = {
      kind: "pane",
      id: "p-right",
      views: [{ kind: "sessions" }],
      activeIndex: 0,
    };
    const prev = rootSplitWith(left, right);
    capture(SLUG, prev, { kind: "close_pane", pane: "p-left" });
    const entries = listClosedPanes(SLUG);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe("Whiteboard");
    expect(entries[0]!.pane.id).toBe("p-left");
  });

  it("ring still evicts at CLOSED_RING_SIZE when populated via the capture path", () => {
    for (let i = 0; i < CLOSED_RING_SIZE + 3; i++) {
      const prev = singlePane([{ kind: "spawn" }]);
      // Use a unique pane id per iteration to make eviction observable.
      const tagged: LayoutNode = { ...(prev as PaneNode), id: `p-${i}` };
      capture(SLUG, tagged, { kind: "close_tab", pane: `p-${i}`, index: 0 });
    }
    const entries = listClosedPanes(SLUG);
    expect(entries).toHaveLength(CLOSED_RING_SIZE);
    expect(entries[0]!.pane.id).toBe(`p-${CLOSED_RING_SIZE + 2}`);
    expect(entries[entries.length - 1]!.pane.id).toBe("p-3");
  });
});
