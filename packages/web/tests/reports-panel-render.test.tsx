import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { layoutStorageKey } from "../src/layout/persistence.ts";
import type { LayoutNode } from "../src/layout/types.ts";

const WORKSPACES = [
  { id: "ws-a", name: "Workspace A", repo_path: "/a", theme: { mode: "dark", accent: "emerald" } },
];

const REPORTS_LAYOUT: LayoutNode = {
  kind: "pane",
  id: "p-reports",
  views: [{ kind: "reports" }],
  activeIndex: 0,
};

let reportsResponse: unknown = { reports: [] };

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
  if (path!.endsWith("/reports")) return Promise.resolve(jsonResponse(reportsResponse));
  return Promise.resolve(jsonResponse([]));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  reportsResponse = { reports: [] };
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

describe("Reports panel (#691)", () => {
  it("shows a plain empty state when the workspace has no reports", async () => {
    localStorage.setItem(layoutStorageKey("workspace-a"), JSON.stringify(REPORTS_LAYOUT));
    reportsResponse = { reports: [] };
    await renderAt("/w/workspace-a");

    expect(container.textContent).toContain("No reports yet");
  });

  it("lists a final report with session label + one-line summary, newest first", async () => {
    localStorage.setItem(layoutStorageKey("workspace-a"), JSON.stringify(REPORTS_LAYOUT));
    reportsResponse = {
      reports: [
        {
          session_id: "sess-1",
          role: "worker",
          label: "worker-issue-42",
          summary: "well: shipped clean | badly: nothing",
          created_at: 1000,
          report: { well: "shipped clean", badly: "nothing" },
        },
      ],
    };
    await renderAt("/w/workspace-a");

    expect(container.querySelector('[data-report-id="sess-1"]')).not.toBeNull();
    expect(container.textContent).toContain("worker-issue-42");
    expect(container.textContent).toContain("well: shipped clean | badly: nothing");
  });

  it("expands a report to show the full well/badly/useful card", async () => {
    localStorage.setItem(layoutStorageKey("workspace-a"), JSON.stringify(REPORTS_LAYOUT));
    reportsResponse = {
      reports: [
        {
          session_id: "sess-1",
          role: "worker",
          label: "worker-issue-42",
          summary: "well: shipped clean | badly: nothing",
          created_at: 1000,
          report: { well: "shipped clean", badly: "nothing" },
        },
      ],
    };
    await renderAt("/w/workspace-a");

    const row = container.querySelector<HTMLElement>('[data-report-id="sess-1"]');
    if (row === null) throw new Error("report row missing");
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await flush();

    expect(container.textContent).toContain("shipped clean");
    expect(container.textContent).toContain("nothing");
  });

  it("renders a free_text report", async () => {
    localStorage.setItem(layoutStorageKey("workspace-a"), JSON.stringify(REPORTS_LAYOUT));
    reportsResponse = {
      reports: [
        {
          session_id: "sess-2",
          role: "worker",
          summary: "shipped, all tests green, no notes",
          created_at: 2000,
          report: { free_text: "shipped, all tests green, no notes" },
        },
      ],
    };
    await renderAt("/w/workspace-a");

    expect(container.textContent).toContain("shipped, all tests green, no notes");
  });
});
