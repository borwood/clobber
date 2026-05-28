import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  loadLayout,
  saveLayout,
  layoutStorageKey,
} from "../src/layout/persistence.ts";
import { defaultLayout } from "../src/layout/default-layout.ts";
import { layoutReducer } from "../src/layout/reducer.ts";

describe("layout persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  it("storage key shape is clobber:layout:v1:<slug>", () => {
    expect(layoutStorageKey("acme")).toBe("clobber:layout:v1:acme");
  });

  it("returns null when no layout is stored for the workspace", () => {
    expect(loadLayout("acme")).toBeNull();
  });

  it("round-trips a layout through localStorage", () => {
    const layout = layoutReducer(defaultLayout(), {
      kind: "resize",
      splitPath: [],
      sizes: [0.3, 0.5, 0.2],
      containerPx: 1000,
    });
    saveLayout("acme", layout);
    const restored = loadLayout("acme");
    expect(restored).toEqual(layout);
  });

  it("isolates layouts per workspace slug", () => {
    saveLayout("alpha", defaultLayout());
    expect(loadLayout("beta")).toBeNull();
  });

  it("ignores stored payloads under an old schema-version key", () => {
    localStorage.setItem(
      "clobber:layout:v0:acme",
      JSON.stringify({ kind: "ancient" }),
    );
    expect(loadLayout("acme")).toBeNull();
  });
});
