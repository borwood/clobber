import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";

const WORKSPACES = [{ id: "ws-a", name: "Workspace A", repo_path: "/a", theme: { mode: "dark", accent: "emerald" } }];

const SESSION = {
  session_id: "sess-1",
  role_name: "worker",
  label: "Worker One",
  first_seen_at: Date.now() - 10_000,
  last_seen_at: Date.now() - 1_000,
  event_count: 3,
};

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
  if (path!.endsWith("/open")) return Promise.resolve(jsonResponse({ dispatched: 0 }));
  if (path === "/sessions") return Promise.resolve(jsonResponse([SESSION]));
  if (path!.endsWith("/transcript")) return Promise.resolve(jsonResponse({ lines: [], cursor: 0 }));
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

async function renderAt(pathname: string) {
  history.replaceState({}, "", pathname);
  await act(async () => {
    root.render(<App />);
  });
  await flush();
}

function paneEl(paneId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
  if (!el) throw new Error(`pane ${paneId} not in DOM`);
  return el;
}

function tabsInPane(paneId: string): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[data-pane-id="${paneId}"] [role="tab"]`),
  );
}

function tabLabels(paneId: string): string[] {
  return tabsInPane(paneId).map((t) => t.textContent ?? "");
}

function stripZone(paneId: string): HTMLElement {
  const el = paneEl(paneId).querySelector<HTMLElement>('[data-drop-edge="tabs"]');
  if (!el) throw new Error(`tab-strip zone not in pane ${paneId}`);
  return el;
}

function dropEdge(paneId: string, edge: string): HTMLElement {
  const el = paneEl(paneId).querySelector<HTMLElement>(`[data-drop-edge="${edge}"]`);
  if (!el) throw new Error(`drop-edge ${edge} not in pane ${paneId}`);
  return el;
}

function caret(paneId: string): HTMLElement | null {
  return paneEl(paneId).querySelector<HTMLElement>('[data-tab-caret="true"]');
}

async function dispatchPointer(
  el: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
) {
  await act(async () => {
    const evt = new Event(type, { bubbles: true, cancelable: true }) as Event & {
      clientX: number;
      clientY: number;
      pointerId: number;
      button: number;
    };
    Object.assign(evt, { clientX, clientY, pointerId: 1, button: 0 });
    el.dispatchEvent(evt);
  });
}

async function dispatchMouse(
  el: EventTarget,
  type: "mousemove" | "mouseout",
  clientX: number,
  clientY: number,
) {
  await act(async () => {
    const evt = new Event(type, { bubbles: true, cancelable: true }) as Event & {
      clientX: number;
      clientY: number;
    };
    Object.assign(evt, { clientX, clientY });
    el.dispatchEvent(evt);
  });
}

async function fireClickOn(el: Element, clientX: number, clientY: number) {
  await act(async () => {
    const evt = new Event("click", { bubbles: true, cancelable: true }) as Event & {
      clientX: number;
      clientY: number;
      button: number;
    };
    Object.assign(evt, { clientX, clientY, button: 0 });
    el.dispatchEvent(evt);
  });
}

async function fireContextMenu(el: Element, clientX: number, clientY: number) {
  await act(async () => {
    const evt = new Event("contextmenu", { bubbles: true, cancelable: true }) as Event & {
      clientX: number;
      clientY: number;
      button: number;
    };
    Object.assign(evt, { clientX, clientY, button: 2 });
    el.dispatchEvent(evt);
  });
}

function sessionRow(): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-pane-id="pane-sessions"] li');
  if (!row) throw new Error("session row not in DOM");
  return row;
}

function menuItem(label: string): HTMLElement | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  return items.find((i) => (i.textContent ?? "").includes(label)) ?? null;
}

// Drag pane-spawn's sole tab onto pane-center's center zone so pane-center
// ends up with two tabs ([Whiteboard, Spawn]) — the precondition for testing
// a same-pane reorder via the strip.
async function consolidateIntoCenter() {
  const spawnTab = tabsInPane("pane-spawn")[0]!;
  const sr = spawnTab.getBoundingClientRect();
  await dispatchPointer(spawnTab, "pointerdown", sr.left + 5, sr.top + 5);
  await dispatchPointer(window, "pointermove", sr.left + 40, sr.top + 40);
  const center = dropEdge("pane-center", "center");
  await dispatchPointer(center, "pointerup", 10, 200);
  await flush();
}

describe("tab-strip drop zone (#318)", () => {
  it("renders a sixth 'tabs' zone alongside the original five during a drag", async () => {
    await renderAt("/w/workspace-a");
    const tab = tabsInPane("pane-center")[0]!;
    const r = tab.getBoundingClientRect();
    await dispatchPointer(tab, "pointerdown", r.left + 5, r.top + 5);
    await dispatchPointer(window, "pointermove", r.left + 20, r.top + 20);

    for (const edge of ["top", "right", "bottom", "left", "center", "tabs"]) {
      expect(dropEdge("pane-center", edge)).toBeTruthy();
    }
    await dispatchPointer(window, "pointerup", r.left + 20, r.top + 20);
  });

  it("move-mode: dropping a tab on another pane's strip moves it into that pane", async () => {
    await renderAt("/w/workspace-a");
    const source = tabsInPane("pane-center")[0]!; // Whiteboard
    const sr = source.getBoundingClientRect();
    await dispatchPointer(source, "pointerdown", sr.left + 5, sr.top + 5);
    await dispatchPointer(window, "pointermove", 10, 10);
    await dispatchPointer(stripZone("pane-spawn"), "pointerup", 10, 5);
    await flush();

    expect(tabLabels("pane-center").some((l) => l.includes("Whiteboard"))).toBe(false);
    expect(tabLabels("pane-spawn").some((l) => l.includes("Whiteboard"))).toBe(true);
  });

  it("move-mode: dropping a tab on its own pane's strip reorders within the pane", async () => {
    await renderAt("/w/workspace-a");
    await consolidateIntoCenter();
    const before = tabLabels("pane-center");
    expect(before[0]!.includes("Whiteboard")).toBe(true);
    expect(before[1]!.includes("Spawn")).toBe(true);

    const first = tabsInPane("pane-center")[0]!; // Whiteboard
    const fr = first.getBoundingClientRect();
    await dispatchPointer(first, "pointerdown", fr.left + 5, fr.top + 5);
    await dispatchPointer(window, "pointermove", fr.left + 30, fr.top + 5);
    await dispatchPointer(stripZone("pane-center"), "pointerup", 300, 5);
    await flush();

    // Zero-size rects in happy-dom make computeDropIndex resolve to the end,
    // so the dragged Whiteboard tab lands after Spawn — a visible reorder.
    const after = tabLabels("pane-center");
    expect(after[0]!.includes("Spawn")).toBe(true);
    expect(after[1]!.includes("Whiteboard")).toBe(true);
  });

  it("insert-mode: clicking a pane's strip opens the pending view in that pane", async () => {
    await renderAt("/w/workspace-a");
    await fireContextMenu(sessionRow(), 50, 50);
    await act(async () => {
      menuItem("Open in pane")!.click();
    });
    await flush();

    await fireClickOn(stripZone("pane-center"), 10, 5);
    await flush();

    expect(tabLabels("pane-center").some((l) => l.includes("Worker One"))).toBe(true);
  });

  it("renders an insertion caret while hovering the strip and removes it on leave", async () => {
    await renderAt("/w/workspace-a");
    const tab = tabsInPane("pane-center")[0]!;
    const r = tab.getBoundingClientRect();
    await dispatchPointer(tab, "pointerdown", r.left + 5, r.top + 5);
    await dispatchPointer(window, "pointermove", r.left + 20, r.top + 20);

    expect(caret("pane-center")).toBeNull();
    await dispatchMouse(stripZone("pane-center"), "mousemove", 40, 5);
    expect(caret("pane-center")).not.toBeNull();

    await dispatchMouse(stripZone("pane-center"), "mouseout", -5, -5);
    expect(caret("pane-center")).toBeNull();

    await dispatchPointer(window, "pointerup", 40, 5);
  });

  it("regression: the top split zone still splits the pane (now reachable below the strip)", async () => {
    await renderAt("/w/workspace-a");
    const source = tabsInPane("pane-center")[0]!;
    const sr = source.getBoundingClientRect();
    await dispatchPointer(source, "pointerdown", sr.left + 5, sr.top + 5);
    await dispatchPointer(window, "pointermove", 10, 10);
    await dispatchPointer(dropEdge("pane-spawn", "top"), "pointerup", 10, 100);
    await flush();

    // Whiteboard migrated into a newly-created pane stacked above pane-spawn.
    const allPanes = Array.from(
      container.querySelectorAll<HTMLElement>('[data-pane="true"]'),
    );
    const holder = allPanes.find((p) =>
      Array.from(p.querySelectorAll<HTMLElement>('[role="tab"]')).some((t) =>
        (t.textContent ?? "").includes("Whiteboard"),
      ),
    );
    expect(holder).toBeDefined();
    expect(holder!.dataset.paneId).not.toBe("pane-center");
  });
});
