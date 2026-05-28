import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";

const WORKSPACES = [{ id: "ws-a", name: "Workspace A", repo_path: "/a" }];

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

const RING_CLASSES = [
  "focus-visible:outline",
  "focus-visible:outline-1",
  "focus-visible:outline-zinc-500",
];

describe("focus-ring grammar (#281 §6.7)", () => {
  it("every pane tab carries the focus-visible ring grammar", async () => {
    await renderAt("/w/workspace-a");
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-pane-tab="true"]'),
    );
    expect(tabs.length).toBeGreaterThan(0);
    for (const t of tabs) {
      for (const cls of RING_CLASSES) {
        expect(t.className).toContain(cls);
      }
    }
  });

  it("every workspace tab anchor carries the focus-visible ring grammar", async () => {
    await renderAt("/w/workspace-a");
    const anchors = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        'header a[aria-current], header a[href^="/w/"]',
      ),
    );
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      for (const cls of RING_CLASSES) {
        expect(a.className).toContain(cls);
      }
    }
  });
});
