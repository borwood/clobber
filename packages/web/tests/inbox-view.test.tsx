import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InboxView } from "../src/views/InboxView.tsx";
import { WorkspaceProvider } from "../src/layout/WorkspaceContext.tsx";
import type { WorkspaceContextValue } from "../src/layout/WorkspaceContext.tsx";

const WORKSPACE_ID = "ws-test";

const BASE_WORKSPACE: WorkspaceContextValue = {
  activeWorkspaceId: WORKSPACE_ID,
  invalidWorkspace: false,
  sessions: [],
  selectedSession: null,
  assignments: [],
  roleId: null,
  setRoleId: () => {},
  offices: [],
  desks: [],
  now: 1_700_000_000_000,
  wakingAgents: new Set(),
  showSystem: false,
  setShowSystem: () => {},
  configOpen: false,
  focusSession: () => {},
  endSession: async () => {},
  resumeSession: async () => {},
  wakeAgent: async () => {},
  userNotificationCount: 0,
  userNotificationHasHigh: false,
};

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "notif-1",
    type: "push",
    priority: "high",
    state: "pending",
    payload: { body: "Build finished successfully" },
    provenance: { source_kind: "push", emitter_agent_id: "agent-abc" },
    metadata: { ref: "main" },
    recipient: { kind: "user" },
    created_at: 1_700_000_000_000,
    delivered_at: undefined,
    acked_at: undefined,
    delivery_mode: undefined,
    ...overrides,
  };
}

let postedAckId: string | null = null;

function mockFetch(input: string, init?: RequestInit): Promise<Response> {
  const [path] = input.split("?");
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  if (path === "/notifications") {
    return Promise.resolve(
      json({
        notifications: [
          makeNotification({ id: "notif-high", priority: "high", payload: { body: "High priority push" } }),
          makeNotification({ id: "notif-low", priority: "low", payload: { body: "Low priority note" } }),
        ],
      }),
    );
  }
  if (path?.match(/^\/notifications\/.+\/ack$/) && init?.method === "POST") {
    const parts = path.split("/");
    postedAckId = parts[2] ?? null;
    return Promise.resolve(json({ ok: true }));
  }
  return Promise.resolve(json([]));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  postedAckId = null;
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

function render(ui: React.ReactNode) {
  act(() => {
    root.render(
      <WorkspaceProvider value={BASE_WORKSPACE}>{ui}</WorkspaceProvider>,
    );
  });
}

describe("InboxView — notification list", () => {
  it("renders both notifications after poll", async () => {
    render(<InboxView />);
    await flush(60);

    const text = container.textContent ?? "";
    expect(text).toContain("High priority push");
    expect(text).toContain("Low priority note");
  });

  it("high-priority row has a loud/unmissable visual marker", async () => {
    render(<InboxView />);
    await flush(60);

    // The high-prio row should carry a data attribute or class marking it as high
    const highRows = container.querySelectorAll("[data-priority='high']");
    expect(highRows.length).toBeGreaterThanOrEqual(1);
  });

  it("low-priority row is not marked as high", async () => {
    render(<InboxView />);
    await flush(60);

    const lowRows = container.querySelectorAll("[data-priority='low']");
    expect(lowRows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("InboxView — detail inspector", () => {
  it("shows inspector content when a notification row is clicked", async () => {
    render(<InboxView />);
    await flush(60);

    // Click the first row
    const rows = container.querySelectorAll("[data-notification-id]");
    expect(rows.length).toBeGreaterThan(0);

    await act(async () => {
      (rows[0] as HTMLElement).click();
    });

    // Inspector should show provenance fields
    const text = container.textContent ?? "";
    expect(text).toContain("push"); // source_kind
    expect(text).toContain("notif-high"); // id in inspector
  });

  it("inspector shows payload body and metadata", async () => {
    render(<InboxView />);
    await flush(60);

    const rows = container.querySelectorAll("[data-notification-id]");
    await act(async () => {
      (rows[0] as HTMLElement).click();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("High priority push");
  });
});

describe("InboxView — ack from panel", () => {
  it("ack button calls POST /notifications/:id/ack after selecting a row", async () => {
    render(<InboxView />);
    await flush(60);

    // Select the first row to reveal the inspector (ack button lives there)
    const rows = container.querySelectorAll("[data-notification-id]");
    await act(async () => {
      (rows[0] as HTMLElement).click();
    });

    const ackButton = container.querySelector("[data-action='ack']") as HTMLElement | null;
    expect(ackButton).not.toBeNull();

    await act(async () => {
      ackButton!.click();
    });

    expect(postedAckId).not.toBeNull();
  });

  it("clicking ack on a specific row acks that notification id", async () => {
    render(<InboxView />);
    await flush(60);

    // Click the first notification row to select it, then ack
    const rows = container.querySelectorAll("[data-notification-id]");
    await act(async () => {
      (rows[0] as HTMLElement).click();
    });

    const ackButton = container.querySelector("[data-action='ack']") as HTMLElement | null;
    await act(async () => {
      ackButton!.click();
    });

    expect(postedAckId).toBe("notif-high");
  });
});
