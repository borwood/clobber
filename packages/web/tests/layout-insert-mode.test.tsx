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
  if (path!.endsWith("/open"))
    return Promise.resolve(jsonResponse({ dispatched: 0 }));
  if (path === "/sessions") return Promise.resolve(jsonResponse([SESSION]));
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

function paneEl(paneId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
  if (!el) throw new Error(`pane ${paneId} not in DOM`);
  return el;
}

function tabsInPane(paneId: string): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-pane-id="${paneId}"] [role="tab"]`,
    ),
  );
}

function dropOverlay(paneId: string): HTMLElement | null {
  return paneEl(paneId).querySelector<HTMLElement>('[data-drop-overlay="true"]');
}

function dropEdge(paneId: string, edge: string): HTMLElement {
  const el = paneEl(paneId).querySelector<HTMLElement>(
    `[data-drop-edge="${edge}"]`,
  );
  if (!el) throw new Error(`drop-edge ${edge} not in pane ${paneId}`);
  return el;
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

async function fireClickOn(el: Element, clientX: number, clientY: number) {
  // happy-dom's HTMLElement.click() doesn't carry coordinates; build the event
  // ourselves so the document-level listener can resolve pane + edge via the
  // same elementFromPoint fallback used in pointer-drag mode.
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

async function fireKey(key: string) {
  await act(async () => {
    const evt = new Event("keydown", { bubbles: true, cancelable: true }) as Event & {
      key: string;
    };
    Object.assign(evt, { key });
    window.dispatchEvent(evt);
  });
}

function sessionRow(): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    '[data-pane-id="pane-sessions"] li',
  );
  if (!row) throw new Error("session row not in DOM");
  return row;
}

function menuItem(label: string): HTMLElement | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  return items.find((i) => (i.textContent ?? "").includes(label)) ?? null;
}

describe("insert-mode drop flow (#316)", () => {
  it("right-click a session row opens a menu with 'Open in pane…' (and not the old 'Pin mailbox' label)", async () => {
    await renderAt("/w/workspace-a");
    await fireContextMenu(sessionRow(), 50, 50);
    expect(menuItem("Open in pane")).not.toBeNull();
    expect(menuItem("Pin mailbox")).toBeNull();
  });

  it("clicking 'Open in pane…' closes the menu and shows the drop overlay in every pane", async () => {
    await renderAt("/w/workspace-a");
    await fireContextMenu(sessionRow(), 50, 50);
    const item = menuItem("Open in pane");
    if (!item) throw new Error("Open in pane menuitem missing");
    await act(async () => {
      item.click();
    });
    await flush();
    expect(menuItem("Open in pane")).toBeNull();
    expect(dropOverlay("pane-center")).not.toBeNull();
    expect(dropOverlay("pane-spawn")).not.toBeNull();
  });

  it("clicking center of a pane in insert-mode opens the mailbox view in that pane and clears insert-mode", async () => {
    await renderAt("/w/workspace-a");
    await fireContextMenu(sessionRow(), 50, 50);
    await act(async () => {
      menuItem("Open in pane")!.click();
    });
    await flush();

    const center = dropEdge("pane-center", "center");
    const r = center.getBoundingClientRect();
    await fireClickOn(center, r.left + r.width / 2, r.top + r.height / 2);
    await flush();

    const labels = tabsInPane("pane-center").map((t) => t.textContent ?? "");
    expect(labels.some((l) => l.includes("Worker One"))).toBe(true);
    expect(dropOverlay("pane-center")).toBeNull();
  });

  it("clicking the right edge of a pane in insert-mode splits the pane and the new pane holds the mailbox view", async () => {
    await renderAt("/w/workspace-a");
    await fireContextMenu(sessionRow(), 50, 50);
    await act(async () => {
      menuItem("Open in pane")!.click();
    });
    await flush();

    const right = dropEdge("pane-center", "right");
    const r = right.getBoundingClientRect();
    await fireClickOn(right, r.left + r.width / 2, r.top + r.height / 2);
    await flush();

    // The new pane is somewhere in the tree (id is generated); find it via
    // the mailbox-labelled tab and verify pane-center kept whiteboard alone.
    const allPanes = Array.from(
      container.querySelectorAll<HTMLElement>('[data-pane="true"]'),
    );
    const newPane = allPanes.find((p) =>
      Array.from(p.querySelectorAll<HTMLElement>('[role="tab"]')).some((t) =>
        (t.textContent ?? "").includes("Worker One"),
      ),
    );
    expect(newPane).toBeDefined();
    expect(newPane!.dataset.paneId).not.toBe("pane-center");
    const centerLabels = tabsInPane("pane-center").map((t) => t.textContent ?? "");
    expect(centerLabels.some((l) => l.includes("Worker One"))).toBe(false);
    expect(dropOverlay("pane-center")).toBeNull();
  });

  it("Escape during insert-mode cancels with no dispatch", async () => {
    await renderAt("/w/workspace-a");
    await fireContextMenu(sessionRow(), 50, 50);
    await act(async () => {
      menuItem("Open in pane")!.click();
    });
    await flush();
    expect(dropOverlay("pane-center")).not.toBeNull();

    await fireKey("Escape");
    await flush();

    expect(dropOverlay("pane-center")).toBeNull();
    const labels = tabsInPane("pane-center").map((t) => t.textContent ?? "");
    expect(labels.some((l) => l.includes("Worker One"))).toBe(false);
  });
});
