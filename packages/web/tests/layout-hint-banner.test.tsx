import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { HINT_DISMISSED_KEY } from "../src/layout/HintBanner.tsx";

const WORKSPACES = [
  { id: "ws-a", name: "Workspace A", repo_path: "/a", theme: { mode: "dark", accent: "emerald" } },
  { id: "ws-b", name: "Workspace B", repo_path: "/b", theme: { mode: "dark", accent: "emerald" } },
];

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
    return Promise.resolve(jsonResponse(["ws-a", "ws-b"]));
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

function hintBanner(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-layout-hint="true"]');
}

describe("first-load layout hint (#281)", () => {
  it("renders the hint when the dismissed key is absent", async () => {
    await renderAt("/w/workspace-a");
    const banner = hintBanner();
    expect(banner).not.toBeNull();
    expect(banner!.textContent ?? "").toContain(
      "Drag tabs between panes; both views can live side by side now.",
    );
  });

  it("hides the hint after the dismiss button is clicked, and persists dismissal", async () => {
    await renderAt("/w/workspace-a");
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-layout-hint-dismiss="true"]',
    );
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await flush();
    expect(hintBanner()).toBeNull();
    expect(localStorage.getItem(HINT_DISMISSED_KEY)).toBe("1");
  });

  it("does not render the hint if the dismissed key is already set", async () => {
    localStorage.setItem(HINT_DISMISSED_KEY, "1");
    await renderAt("/w/workspace-a");
    expect(hintBanner()).toBeNull();
  });
});

describe("workspace-scoped layout key (#281)", () => {
  it("uses independent localStorage keys for two distinct workspaces", async () => {
    await renderAt("/w/workspace-a");
    expect(localStorage.getItem("clobber:layout:v2:workspace-a")).not.toBeNull();
    expect(localStorage.getItem("clobber:layout:v2:workspace-b")).toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderAt("/w/workspace-b");
    expect(localStorage.getItem("clobber:layout:v2:workspace-b")).not.toBeNull();
  });
});
