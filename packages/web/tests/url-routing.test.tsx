import { GlobalRegistrator } from "@happy-dom/global-registrator";
// A real base URL so relative history.pushState/replaceState resolve and
// update location.pathname (about:blank, the default, leaves pathname stuck).
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";

// Two workspaces; both carry a live session so both earn a tab regardless of
// which is selected. The bad-id scenario uses an id absent from this list.
const WORKSPACES = [
  { id: "ws-a", name: "Workspace A", repo_path: "/a" },
  { id: "ws-b", name: "Workspace B", repo_path: "/b" },
];
const LIVE_WORKSPACE_IDS = ["ws-a", "ws-b"];

const fetchCalls: string[] = [];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(input: string): Promise<Response> {
  fetchCalls.push(input);
  const [path] = input.split("?");
  if (path === "/workspaces") return Promise.resolve(jsonResponse(WORKSPACES));
  if (path === "/sessions/live-workspaces") {
    return Promise.resolve(jsonResponse(LIVE_WORKSPACE_IDS));
  }
  if (path!.endsWith("/roles")) return Promise.resolve(jsonResponse([]));
  if (path!.endsWith("/open")) return Promise.resolve(jsonResponse({ dispatched: 0 }));
  if (path === "/sessions") return Promise.resolve(jsonResponse([]));
  if (path!.endsWith("/transcript")) return Promise.resolve(jsonResponse([]));
  return Promise.resolve(jsonResponse([]));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchCalls.length = 0;
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

function tabLinks(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll("a")).filter(
    (a) => (a.getAttribute("href") ?? "").startsWith("/w/"),
  );
}

function selectedTab(): HTMLAnchorElement | undefined {
  return tabLinks().find((a) => a.getAttribute("aria-current") === "page");
}

describe("URL-driven workspace selection + tab bar (#6)", () => {
  it("/w/:id drives the active workspace and marks its tab selected", async () => {
    await renderAt("/w/ws-a");

    // Active workspace → right rail shows the spawn affordance, not the empty prompt.
    expect(container.textContent).not.toContain("to spawn agents");

    const hrefs = tabLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/w/ws-a");
    expect(hrefs).toContain("/w/ws-b");
    expect(selectedTab()?.getAttribute("href")).toBe("/w/ws-a");
  });

  it("clicking a tab navigates without reload (pushState) and reselects", async () => {
    await renderAt("/w/ws-a");

    const tabB = tabLinks().find((a) => a.getAttribute("href") === "/w/ws-b")!;
    await act(async () => {
      // A plain left-click must be intercepted (preventDefault + pushState).
      tabB.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await flush();

    expect(location.pathname).toBe("/w/ws-b");
    expect(selectedTab()?.getAttribute("href")).toBe("/w/ws-b");
  });

  it("back/forward (popstate) re-derives selection from the URL", async () => {
    await renderAt("/w/ws-b");
    expect(selectedTab()?.getAttribute("href")).toBe("/w/ws-b");

    await act(async () => {
      history.pushState({}, "", "/w/ws-a");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();

    expect(selectedTab()?.getAttribute("href")).toBe("/w/ws-a");
  });

  it("tabs are real anchors so middle/right-click opens a new window natively", async () => {
    await renderAt("/w/ws-a");
    const tabB = tabLinks().find((a) => a.getAttribute("href") === "/w/ws-b")!;
    expect(tabB.tagName).toBe("A");
    expect(tabB.getAttribute("href")).toBe("/w/ws-b");
  });

  it("/w/:id/s/:sid focuses the session (deep link fetches its transcript)", async () => {
    await renderAt("/w/ws-a/s/sess-1");
    expect(fetchCalls.some((c) => c.includes("/sessions/sess-1/transcript"))).toBe(true);
  });

  it("/w/<bad-id> falls back to an empty state with a clear message", async () => {
    await renderAt("/w/ghost");
    expect(container.textContent).toContain("not found");
    expect(selectedTab()).toBeUndefined();
  });

  it("/ is the empty state — no workspace auto-selected", async () => {
    await renderAt("/");
    expect(container.textContent).toContain("to spawn agents");
    expect(selectedTab()).toBeUndefined();
  });
});
