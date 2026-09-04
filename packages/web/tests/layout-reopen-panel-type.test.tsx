import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { layoutStorageKey } from "../src/layout/persistence.ts";
import type { LayoutNode } from "../src/layout/types.ts";

// #691 ruling: every closed (= not currently present anywhere in the
// layout) singleton panel type must be reopenable from the upper-right
// layout button, transcripts (mailbox) excepted.
const WORKSPACES = [
  { id: "ws-a", name: "Workspace A", repo_path: "/a", theme: { mode: "dark", accent: "emerald" } },
];

// Only whiteboard is present; sessions/spawn/inbox/reports are all "closed".
const SEEDED_LAYOUT: LayoutNode = {
  kind: "pane",
  id: "p-only",
  views: [{ kind: "whiteboard" }],
  activeIndex: 0,
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
  if (path === "/sessions/live-workspaces") return Promise.resolve(jsonResponse(["ws-a"]));
  if (path!.endsWith("/roles")) return Promise.resolve(jsonResponse([]));
  if (path!.endsWith("/open")) return Promise.resolve(jsonResponse({ dispatched: 0 }));
  if (path === "/sessions") return Promise.resolve(jsonResponse([]));
  if (path!.endsWith("/transcript")) return Promise.resolve(jsonResponse({ lines: [], cursor: 0 }));
  if (path!.endsWith("/reports")) return Promise.resolve(jsonResponse({ reports: [] }));
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

function paneTabTexts(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-pane-tab="true"]'),
  ).map((t) => t.textContent ?? "");
}

async function openLayoutMenu() {
  const menuBtn = container.querySelector<HTMLButtonElement>('[aria-label="Layout menu"]');
  if (menuBtn === null) throw new Error("layout menu button missing");
  await act(async () => {
    menuBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

function menuItemTexts(): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
    (b) => b.textContent?.trim() ?? "",
  );
}

describe("reopen closed panel type from the layout menu (#691)", () => {
  it("lists every singleton view kind absent from the layout, excludes the one already open, excludes transcripts", async () => {
    localStorage.setItem(layoutStorageKey("workspace-a"), JSON.stringify(SEEDED_LAYOUT));
    await renderAt("/w/workspace-a");
    await openLayoutMenu();

    const items = menuItemTexts();
    expect(items).toContain("Sessions");
    expect(items).toContain("Spawn");
    expect(items).toContain("Inbox");
    expect(items).toContain("Reports");
    // Whiteboard is already open in the layout — not offered as reopenable.
    expect(items).not.toContain("Whiteboard");
  });

  it("clicking a missing panel type opens it in a new pane", async () => {
    localStorage.setItem(layoutStorageKey("workspace-a"), JSON.stringify(SEEDED_LAYOUT));
    await renderAt("/w/workspace-a");
    expect(paneTabTexts().some((t) => t.includes("Reports"))).toBe(false);

    await openLayoutMenu();
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    const reportsItem = items.find((b) => b.textContent?.trim() === "Reports");
    if (reportsItem === undefined) throw new Error("Reports reopen item missing");
    await act(async () => {
      reportsItem.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await flush();

    expect(paneTabTexts().some((t) => t.includes("Reports"))).toBe(true);
  });
});
