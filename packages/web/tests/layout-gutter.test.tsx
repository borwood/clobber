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

function gutters(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-gutter="true"]'),
  );
}

describe("Gutter rendering + resize wiring (#279)", () => {
  it("renders one gutter between each adjacent pair of panes in the default horizontal split", async () => {
    await renderAt("/w/workspace-a");
    const panes = container.querySelectorAll('[data-pane="true"]');
    expect(panes.length).toBe(3);
    expect(gutters().length).toBe(2);
  });

  it("each gutter advertises the col-resize cursor and a separator role", async () => {
    await renderAt("/w/workspace-a");
    for (const g of gutters()) {
      expect(g.className).toContain("cursor-col-resize");
      expect(g.getAttribute("role")).toBe("separator");
      expect(g.getAttribute("aria-orientation")).toBe("vertical");
    }
  });
});
