import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayoutProvider, useLayout } from "../src/layout/provider.tsx";
import { layoutStorageKey } from "../src/layout/persistence.ts";
import type { LayoutNode } from "../src/layout/types.ts";
import type { SequencedLayoutEvent } from "@clobber/shared";

// The bridge (#326) is delivered over the existing HTTP-poll transport — there
// is no WebSocket in this codebase — so the server half is just a poll endpoint
// the provider subscribes to. The mock plays that endpoint: it hands back a
// single swap_session_tab event on the first poll (since=0) and nothing after,
// mirroring the real per-client cursor.
const WORKSPACE_ID = "ws-a";
const WORKSPACE_SLUG = "workspace-a";
const OLD_SESSION = "sess-old-11111111";
const NEW_SESSION = "sess-new-22222222";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function layoutEventsResponse(since: number): SequencedLayoutEvent[] {
  if (since >= 1) return [];
  return [
    {
      seq: 1,
      event: {
        kind: "layout",
        action: {
          type: "swap_session_tab",
          oldSessionId: OLD_SESSION,
          newSessionId: NEW_SESSION,
        },
      },
    },
  ];
}

function mockFetch(input: string): Promise<Response> {
  const [path, query] = input.split("?");
  if (path === `/workspaces/${WORKSPACE_ID}/layout-events`) {
    const since = Number(new URLSearchParams(query).get("since") ?? "0");
    return Promise.resolve(jsonResponse(layoutEventsResponse(since)));
  }
  return Promise.resolve(jsonResponse([]));
}

function mailboxSessionIds(node: LayoutNode): string[] {
  if (node.kind === "pane") {
    return node.views.flatMap((v) => (v.kind === "mailbox" ? [v.sessionId] : []));
  }
  return node.children.flatMap(mailboxSessionIds);
}

function firstPaneActiveIndex(node: LayoutNode): number | null {
  if (node.kind === "pane") return node.activeIndex;
  for (const c of node.children) {
    const hit = firstPaneActiveIndex(c);
    if (hit !== null) return hit;
  }
  return null;
}

let probedLayout: LayoutNode | null = null;

function Probe() {
  const { layout } = useLayout();
  probedLayout = layout;
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  probedLayout = null;
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

function seedLayout(layout: LayoutNode) {
  localStorage.setItem(layoutStorageKey(WORKSPACE_SLUG), JSON.stringify(layout));
}

async function render() {
  await act(async () => {
    root.render(
      <LayoutProvider
        workspaceSlug={WORKSPACE_SLUG}
        workspaceId={WORKSPACE_ID}
        deepLinkSessionId={null}
      >
        <Probe />
      </LayoutProvider>,
    );
  });
  await flush();
}

describe("server→web layout bridge (#326)", () => {
  it("swaps the open mailbox tab's session-id in place, preserving activeIndex", async () => {
    seedLayout({
      kind: "split",
      direction: "h",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", id: "p1", views: [{ kind: "sessions" }], activeIndex: 0 },
        {
          kind: "pane",
          id: "p2",
          views: [
            { kind: "whiteboard" },
            { kind: "mailbox", sessionId: OLD_SESSION },
          ],
          activeIndex: 1,
        },
      ],
    });

    await render();

    expect(probedLayout).not.toBeNull();
    const ids = mailboxSessionIds(probedLayout!);
    expect(ids).toEqual([NEW_SESSION]);
    expect(ids).not.toContain(OLD_SESSION);

    // The swapped tab keeps its pane position and active selection.
    const p2 = (probedLayout as Extract<LayoutNode, { kind: "split" }>).children[1];
    expect(p2?.kind).toBe("pane");
    const pane = p2 as Extract<LayoutNode, { kind: "pane" }>;
    expect(pane.activeIndex).toBe(1);
    expect(pane.views[1]).toEqual({ kind: "mailbox", sessionId: NEW_SESSION });
  });

  it("is a clean no-op when no tab is open for the old session-id", async () => {
    seedLayout({
      kind: "pane",
      id: "only",
      views: [{ kind: "sessions" }, { kind: "whiteboard" }],
      activeIndex: 0,
    });

    await render();

    expect(probedLayout).not.toBeNull();
    expect(mailboxSessionIds(probedLayout!)).toEqual([]);
    expect(firstPaneActiveIndex(probedLayout!)).toBe(0);
  });
});
