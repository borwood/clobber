import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";

const WORKSPACES = [{ id: "ws-a", name: "Workspace A", repo_path: "/a", theme: { mode: "dark", accent: "emerald" } }];

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

async function renderAt(pathname: string) {
  history.replaceState({}, "", pathname);
  await act(async () => {
    root.render(<App />);
  });
  await flush();
}

function tabsInPane(paneId: string): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-pane-id="${paneId}"] [role="tab"]`,
    ),
  );
}

function paneEl(paneId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
  if (!el) throw new Error(`pane ${paneId} not in DOM`);
  return el;
}

function ghost(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-drag-ghost="true"]');
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

describe("tab drag between panes (#280)", () => {
  it("pointer-down on a tab renders a floating ghost", async () => {
    await renderAt("/w/workspace-a");
    expect(ghost()).toBeNull();
    const centerTabs = tabsInPane("pane-center");
    expect(centerTabs.length).toBeGreaterThan(0);
    const first = centerTabs[0]!;
    const r = first.getBoundingClientRect();
    await dispatchPointer(first, "pointerdown", r.left + 5, r.top + 5);
    await dispatchPointer(window, "pointermove", r.left + 15, r.top + 15);
    expect(ghost()).not.toBeNull();
  });

  it("pointer-up over another pane moves the tab there and leaves source pane empty", async () => {
    await renderAt("/w/workspace-a");
    const sourceTab = tabsInPane("pane-center")[0]!; // whiteboard tab
    const sr = sourceTab.getBoundingClientRect();
    const targetPane = paneEl("pane-spawn");
    const tr = targetPane.getBoundingClientRect();

    await dispatchPointer(sourceTab, "pointerdown", sr.left + 5, sr.top + 5);
    await dispatchPointer(window, "pointermove", tr.left + 10, tr.top + 10);
    await dispatchPointer(targetPane, "pointerup", tr.left + 10, tr.top + 10);
    await flush();

    const centerLabels = tabsInPane("pane-center").map((t) => t.textContent ?? "");
    expect(centerLabels.some((l) => l.includes("Whiteboard"))).toBe(false);
    const spawnLabels = tabsInPane("pane-spawn").map((t) => t.textContent ?? "");
    expect(spawnLabels.some((l) => l.includes("Whiteboard"))).toBe(true);
    expect(ghost()).toBeNull();
  });
});
