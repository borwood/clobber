import { GlobalRegistrator } from "@happy-dom/global-registrator";
// A real base URL so relative history.pushState/replaceState resolve and
// update location.pathname (about:blank, the default, leaves pathname stuck).
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";

// Two workspaces; URLs are human-readable slugs derived from the name
// (slugify("Workspace A") === "workspace-a"). The unknown-slug scenario uses a
// slug absent from this list.
const WORKSPACES = [
  { id: "ws-a", name: "Workspace A", repo_path: "/a" },
  { id: "ws-b", name: "Workspace B", repo_path: "/b" },
];

// Mutable so a test can simulate "zero live sessions" (the dead-end scenario).
let liveIds: string[] = ["ws-a", "ws-b"];

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
    return Promise.resolve(jsonResponse(liveIds));
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
  liveIds = ["ws-a", "ws-b"];
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
    (a) =>
      (a.getAttribute("href") ?? "").startsWith("/w/") &&
      a.closest('[role="menu"]') === null,
  );
}

function menuLinks(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll('[role="menu"] a'));
}

function selectedTab(): HTMLAnchorElement | undefined {
  return tabLinks().find((a) => a.getAttribute("aria-current") === "page");
}

function clickLeft(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

function openMenu(): Promise<void> {
  const opener = container.querySelector('[aria-label="Open workspace menu"]')!;
  return clickLeft(opener);
}

describe("URL-driven workspace selection + tab bar (#6, slug URLs #243)", () => {
  it("/w/:slug drives the active workspace and marks its tab selected", async () => {
    await renderAt("/w/workspace-a");

    // Active workspace → right rail shows the spawn affordance, not the empty prompt.
    expect(container.textContent).not.toContain("to spawn agents");

    const hrefs = tabLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/w/workspace-a");
    expect(hrefs).toContain("/w/workspace-b");
    expect(selectedTab()?.getAttribute("href")).toBe("/w/workspace-a");
  });

  it("clicking a tab navigates without reload (pushState) and reselects", async () => {
    await renderAt("/w/workspace-a");

    const tabB = tabLinks().find((a) => a.getAttribute("href") === "/w/workspace-b")!;
    await clickLeft(tabB);
    await flush();

    expect(location.pathname).toBe("/w/workspace-b");
    expect(selectedTab()?.getAttribute("href")).toBe("/w/workspace-b");
  });

  it("back/forward (popstate) re-derives selection from the URL", async () => {
    await renderAt("/w/workspace-b");
    expect(selectedTab()?.getAttribute("href")).toBe("/w/workspace-b");

    await act(async () => {
      history.pushState({}, "", "/w/workspace-a");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();

    expect(selectedTab()?.getAttribute("href")).toBe("/w/workspace-a");
  });

  it("tabs are real anchors so middle/right-click opens a new window natively", async () => {
    await renderAt("/w/workspace-a");
    const tabB = tabLinks().find((a) => a.getAttribute("href") === "/w/workspace-b")!;
    expect(tabB.tagName).toBe("A");
    expect(tabB.getAttribute("href")).toBe("/w/workspace-b");
  });

  it("/w/:slug/s/:sid focuses the session (deep link fetches its transcript)", async () => {
    await renderAt("/w/workspace-a/s/sess-1");
    expect(fetchCalls.some((c) => c.includes("/sessions/sess-1/transcript"))).toBe(true);
  });

  it("/w/<unknown-slug> falls back to an empty state with a clear message", async () => {
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

describe("[+] workspace dropdown (#243 dead-end fix)", () => {
  it("with zero live sessions at /, the [+] dropdown lists all workspaces and navigates", async () => {
    liveIds = [];
    await renderAt("/");

    // Dead-end guard: nothing live, nothing selected → no tabs at all.
    expect(tabLinks()).toHaveLength(0);

    await openMenu();
    const hrefs = menuLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/w/workspace-a");
    expect(hrefs).toContain("/w/workspace-b");

    const itemA = menuLinks().find((a) => a.getAttribute("href") === "/w/workspace-a")!;
    await clickLeft(itemA);
    await flush();

    expect(location.pathname).toBe("/w/workspace-a");
  });

  it("the create form is the dropdown's sticky bottom item; no standalone create affordance", async () => {
    await renderAt("/w/workspace-a");

    // The old standalone "+ new" header affordance is gone — name input only
    // exists once the dropdown's create item is opened.
    expect(container.querySelector('input[placeholder="name"]')).toBeNull();

    await openMenu();
    const createItem = within(container, "+ new workspace");
    await clickLeft(createItem);
    await flush();

    const nameInput = container.querySelector('[role="menu"] input[placeholder="name"]');
    expect(nameInput).not.toBeNull();
  });
});

function within(root: ParentNode, text: string): Element {
  const el = Array.from(root.querySelectorAll("button, a")).find((e) =>
    (e.textContent ?? "").includes(text),
  );
  if (el === undefined) throw new Error(`no clickable element containing "${text}"`);
  return el;
}
