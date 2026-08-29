import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { layoutStorageKey } from "../src/layout/persistence.ts";
import type { LayoutNode } from "../src/layout/types.ts";

// #695 — switching workspaces must not leak the previous workspace's layout
// (mailbox panels bound to its sessions) into the new one, and must not
// overwrite the previous workspace's own saved layout with the leaked state.
const WORKSPACE_A_ID = "ws-a";
const WORKSPACE_B_ID = "ws-b";
const WORKSPACE_A_SLUG = "workspace-a";
const WORKSPACE_B_SLUG = "workspace-b";
const SESSION_A = "sess-a-11112222";

const WORKSPACES = [
  { id: WORKSPACE_A_ID, name: "Workspace A", repo_path: "/a", theme: { mode: "dark", accent: "emerald" } },
  { id: WORKSPACE_B_ID, name: "Workspace B", repo_path: "/b", theme: { mode: "dark", accent: "emerald" } },
];

const SEEDED_LAYOUT_A: LayoutNode = {
  kind: "split",
  direction: "h",
  sizes: [0.5, 0.5],
  children: [
    { kind: "pane", id: "p1", views: [{ kind: "sessions" }], activeIndex: 0 },
    {
      kind: "pane",
      id: "p2",
      views: [{ kind: "mailbox", sessionId: SESSION_A }],
      activeIndex: 0,
    },
  ],
};

// B's own saved layout — distinct from both A's layout and the default, so a
// post-switch render can distinguish "B's own layout was restored" from
// "A's layout (or the default) leaked in". The inbox pane is the marker: it
// appears in neither A's seeded layout nor defaultLayout().
const SEEDED_LAYOUT_B: LayoutNode = {
  kind: "pane",
  id: "b-only",
  views: [{ kind: "inbox" }],
  activeIndex: 0,
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(input: string): Promise<Response> {
  const [path, query] = input.split("?");
  if (path === "/workspaces") return Promise.resolve(jsonResponse(WORKSPACES));
  if (path === "/sessions/live-workspaces")
    return Promise.resolve(jsonResponse([WORKSPACE_A_ID, WORKSPACE_B_ID]));
  if (path!.endsWith("/roles")) return Promise.resolve(jsonResponse([]));
  if (path!.endsWith("/open")) return Promise.resolve(jsonResponse({ dispatched: 0 }));
  if (path === "/sessions") {
    const workspaceId = new URLSearchParams(query).get("workspace_id");
    if (workspaceId === WORKSPACE_A_ID) {
      return Promise.resolve(
        jsonResponse([
          {
            session_id: SESSION_A,
            role_name: "worker",
            label: "worker-issue-42",
            first_seen_at: 0,
            last_seen_at: 0,
            event_count: 1,
          },
        ]),
      );
    }
    return Promise.resolve(jsonResponse([]));
  }
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

function paneTabTexts(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-pane-tab="true"]'),
  ).map((t) => t.textContent ?? "");
}

function clickWorkspaceTab(name: string): void {
  const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('[role="tab"]')).find(
    (a) => (a.textContent ?? "").includes(name),
  );
  if (link === undefined) throw new Error(`no workspace tab for ${name}`);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("workspace switch does not leak layout/transcript panels (#695)", () => {
  it("restores B's own layout, drops A's mailbox panes, and leaves both workspaces' storage intact", async () => {
    localStorage.setItem(layoutStorageKey(WORKSPACE_A_SLUG), JSON.stringify(SEEDED_LAYOUT_A));
    localStorage.setItem(layoutStorageKey(WORKSPACE_B_SLUG), JSON.stringify(SEEDED_LAYOUT_B));

    await renderAt(`/w/${WORKSPACE_A_SLUG}`);
    expect(paneTabTexts().some((t) => t.includes("worker-issue-42"))).toBe(true);

    await act(async () => {
      clickWorkspaceTab("Workspace B");
    });
    await flush();

    const tabsAfterSwitch = paneTabTexts();
    expect(tabsAfterSwitch.some((t) => t.includes(SESSION_A.slice(0, 8)))).toBe(false);
    expect(tabsAfterSwitch.some((t) => t.includes("worker-issue-42"))).toBe(false);
    // B's own saved layout (the inbox pane) is what's actually restored, not
    // A's leaked panes and not a freshly-derived default layout.
    expect(tabsAfterSwitch.some((t) => t.includes("Inbox"))).toBe(true);

    const storedA = localStorage.getItem(layoutStorageKey(WORKSPACE_A_SLUG));
    expect(storedA).toBe(JSON.stringify(SEEDED_LAYOUT_A));

    // This is the destination side of the leak: the bug's causal chain
    // persisted A's carried-over panes under B's own storage key, clobbering
    // B's saved layout on every switch.
    const storedB = localStorage.getItem(layoutStorageKey(WORKSPACE_B_SLUG));
    expect(storedB).toBe(JSON.stringify(SEEDED_LAYOUT_B));
  });
});
