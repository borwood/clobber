import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { layoutStorageKey } from "../src/layout/persistence.ts";
import type { LayoutNode } from "../src/layout/types.ts";

const WORKSPACES = [{ id: "ws-a", name: "Workspace A", repo_path: "/a" }];
const SLUG = "workspace-a";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(input: string): Promise<Response> {
  const [path] = input.split("?");
  if (path === "/workspaces") return Promise.resolve(jsonResponse(WORKSPACES));
  if (path === "/sessions/live-workspaces")
    return Promise.resolve(jsonResponse(["ws-a"]));
  if (path!.endsWith("/roles")) return Promise.resolve(jsonResponse([]));
  if (path!.endsWith("/open"))
    return Promise.resolve(jsonResponse({ dispatched: 0 }));
  if (path === "/sessions") return Promise.resolve(jsonResponse([]));
  if (path!.endsWith("/transcript")) return Promise.resolve(jsonResponse([]));
  return Promise.resolve(jsonResponse([]));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  (globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function seedLayout(layout: LayoutNode) {
  localStorage.setItem(layoutStorageKey(SLUG), JSON.stringify(layout));
}

async function renderWith(layout: LayoutNode) {
  seedLayout(layout);
  history.replaceState({}, "", `/w/${SLUG}`);
  await act(async () => {
    root.render(<App />);
  });
  await flush();
}

function paneBody(paneId: string): HTMLElement {
  const pane = container.querySelector<HTMLElement>(
    `[data-pane-id="${paneId}"]`,
  );
  if (!pane) throw new Error(`pane ${paneId} not in DOM`);
  // Dispatch from a deep descendant so React's bubbling reaches the
  // onContextMenu handler attached to the empty-pane body.
  const deepest = pane.querySelector<HTMLElement>("span, div div div") ?? pane;
  return deepest;
}

function emptyRootLayout(): LayoutNode {
  return { kind: "pane", id: "pane-empty-root", views: [], activeIndex: null };
}

function splitWithEmptyChild(): LayoutNode {
  return {
    kind: "split",
    direction: "h",
    sizes: [0.5, 0.5],
    children: [
      { kind: "pane", id: "pane-with-tab", views: [{ kind: "whiteboard" }], activeIndex: 0 },
      { kind: "pane", id: "pane-empty-child", views: [], activeIndex: null },
    ],
  };
}

async function rightClickInside(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 120,
      }),
    );
  });
  await flush();
}

function menuRoot(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-empty-pane-menu="true"]');
}

function menuItems(): HTMLButtonElement[] {
  const m = menuRoot();
  if (!m) return [];
  return Array.from(m.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function tabLabelsInPane(paneId: string): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-pane-id="${paneId}"] [role="tab"]`,
    ),
  ).map((t) => (t.textContent ?? "").toLowerCase());
}

describe("empty-pane context menu (#314)", () => {
  it("right-click on empty root pane shows menu with Sessions / Whiteboard / Spawn", async () => {
    await renderWith(emptyRootLayout());
    expect(menuRoot()).toBeNull();
    await rightClickInside(paneBody("pane-empty-root"));
    const items = menuItems();
    const labels = items.map((b) => (b.textContent ?? "").trim());
    expect(labels).toEqual(["Sessions", "Whiteboard", "Spawn"]);
  });

  it("right-click on empty non-root pane shows the same menu", async () => {
    await renderWith(splitWithEmptyChild());
    await rightClickInside(paneBody("pane-empty-child"));
    const labels = menuItems().map((b) => (b.textContent ?? "").trim());
    expect(labels).toEqual(["Sessions", "Whiteboard", "Spawn"]);
  });

  it("clicking Sessions opens a sessions tab in that pane and closes the menu", async () => {
    await renderWith(emptyRootLayout());
    await rightClickInside(paneBody("pane-empty-root"));
    const sessions = menuItems().find(
      (b) => (b.textContent ?? "").trim() === "Sessions",
    );
    expect(sessions).toBeDefined();
    await act(async () => {
      sessions!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await flush();
    expect(menuRoot()).toBeNull();
    expect(tabLabelsInPane("pane-empty-root").some((l) => l.includes("sessions"))).toBe(
      true,
    );
  });

  it("outside-click closes the menu without dispatching", async () => {
    await renderWith(emptyRootLayout());
    await rightClickInside(paneBody("pane-empty-root"));
    expect(menuRoot()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(menuRoot()).toBeNull();
    expect(tabLabelsInPane("pane-empty-root").length).toBe(0);
  });

  it("Escape closes the menu without dispatching", async () => {
    await renderWith(emptyRootLayout());
    await rightClickInside(paneBody("pane-empty-root"));
    expect(menuRoot()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await flush();
    expect(menuRoot()).toBeNull();
    expect(tabLabelsInPane("pane-empty-root").length).toBe(0);
  });
});
