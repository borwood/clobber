import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  listSavedLayouts,
  loadSavedLayout,
  saveSavedLayout,
  savedLayoutKey,
  pushClosedPane,
  listClosedPanes,
  closedRingKey,
  CLOSED_RING_SIZE,
} from "../src/layout/persistence.ts";
import type { PaneNode } from "../src/layout/types.ts";
import { defaultLayout } from "../src/layout/default-layout.ts";

const pane = (id: string): PaneNode => ({
  kind: "pane",
  id,
  views: [{ kind: "whiteboard" }],
  activeIndex: 0,
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("saved layouts persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("key shape is clobber:layout:v2:<slug>:saved:<name>", () => {
    expect(savedLayoutKey("acme", "A")).toBe("clobber:layout:v2:acme:saved:A");
  });

  it("save + load round-trips a named layout", () => {
    saveSavedLayout("acme", "A", defaultLayout());
    expect(loadSavedLayout("acme", "A")).toEqual(defaultLayout());
  });

  it("listSavedLayouts returns names sorted, scoped to the workspace slug", () => {
    saveSavedLayout("acme", "B", defaultLayout());
    saveSavedLayout("acme", "A", defaultLayout());
    saveSavedLayout("other", "Z", defaultLayout());
    expect(listSavedLayouts("acme")).toEqual(["A", "B"]);
  });

  it("loadSavedLayout returns null for unknown names", () => {
    expect(loadSavedLayout("acme", "ghost")).toBeNull();
  });
});

describe("closed-pane ring buffer", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("key shape is clobber:layout:v2:<slug>:closed-ring", () => {
    expect(closedRingKey("acme")).toBe("clobber:layout:v2:acme:closed-ring");
  });

  it("pushes entries newest-first and stores label + timestamp", () => {
    pushClosedPane("acme", pane("p1"), "Whiteboard", 1000);
    pushClosedPane("acme", pane("p2"), "Sessions", 2000);
    const entries = listClosedPanes("acme");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.label).toBe("Sessions");
    expect(entries[0]!.closedAt).toBe(2000);
    expect(entries[0]!.pane.id).toBe("p2");
    expect(entries[1]!.label).toBe("Whiteboard");
  });

  it("evicts oldest entries past CLOSED_RING_SIZE", () => {
    for (let i = 0; i < CLOSED_RING_SIZE + 3; i++) {
      pushClosedPane("acme", pane(`p${i}`), `L${i}`, i);
    }
    const entries = listClosedPanes("acme");
    expect(entries).toHaveLength(CLOSED_RING_SIZE);
    expect(entries[0]!.pane.id).toBe(`p${CLOSED_RING_SIZE + 2}`);
    const oldestKept = entries[entries.length - 1]!;
    expect(oldestKept.pane.id).toBe("p3");
  });

  it("scopes the ring per workspace slug", () => {
    pushClosedPane("alpha", pane("a"), "A", 1);
    expect(listClosedPanes("beta")).toEqual([]);
  });
});
