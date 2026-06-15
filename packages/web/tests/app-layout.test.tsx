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

function paneTabs(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-pane-tab="true"]'),
  );
}

describe("App layout migration (#278)", () => {
  it("renders three panes from the default layout", async () => {
    await renderAt("/w/workspace-a");
    const panes = container.querySelectorAll('[data-pane="true"]');
    expect(panes.length).toBe(3);
  });

  it("default layout: sessions / whiteboard / spawn — one tab per pane", async () => {
    await renderAt("/w/workspace-a");
    const labels = paneTabs().map((t) => (t.textContent ?? "").toLowerCase());
    expect(labels.some((l) => l.includes("sessions"))).toBe(true);
    expect(labels.some((l) => l.includes("whiteboard"))).toBe(true);
    expect(labels.some((l) => l.includes("spawn"))).toBe(true);
  });

  it("clicking the whiteboard tab swaps the active view in its pane", async () => {
    await renderAt("/w/workspace-a");
    const wb = paneTabs().find((t) =>
      (t.textContent ?? "").toLowerCase().includes("whiteboard"),
    );
    expect(wb).toBeDefined();
    await act(async () => {
      wb!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await flush();
    expect(wb!.getAttribute("aria-selected")).toBe("true");
  });

  it("every pane tab exposes a cursor-grab drag affordance", async () => {
    await renderAt("/w/workspace-a");
    const tabs = paneTabs();
    expect(tabs.length).toBeGreaterThan(0);
    for (const t of tabs) {
      expect(t.className).toContain("cursor-grab");
    }
  });

  it("header has a layout menu", async () => {
    await renderAt("/w/workspace-a");
    const btn = container.querySelector('[aria-label="Layout menu"]');
    expect(btn).not.toBeNull();
  });

  it("ViewSwitcher component is no longer in the tree", async () => {
    await renderAt("/w/workspace-a");
    expect(
      container.querySelector('[aria-label="content view"]'),
    ).toBeNull();
  });
});
