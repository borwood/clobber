import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InboxView } from "../src/views/InboxView.tsx";
import { WorkspaceProvider } from "../src/layout/WorkspaceContext.tsx";
import type { WorkspaceContextValue } from "../src/layout/WorkspaceContext.tsx";
import type { Notification } from "../src/api.ts";

const WORKSPACE_ID = "ws-test";

const STUB_TAG = { kind: "trigger" as const, attrs: {} };

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "notif-1",
    type: "push",
    category: "durable",
    recipient: { kind: "user" },
    priority: "high",
    state: "pending",
    payload: { body: "Build finished successfully", tag: STUB_TAG },
    provenance: { source_kind: "push", emitter_agent_id: "agent-abc" },
    metadata: { ref: "main" },
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

const HIGH_NOTIF = makeNotification({
  id: "notif-high",
  priority: "high",
  payload: { body: "High priority push", tag: STUB_TAG },
  metadata: { ref: "main", run_id: "42" },
  provenance: { source_kind: "push", emitter_agent_id: "agent-abc" },
});

const LOW_NOTIF = makeNotification({
  id: "notif-low",
  priority: "low",
  payload: { body: "Low priority note", tag: STUB_TAG },
  metadata: {},
});

function makeWorkspace(userNotifications: readonly Notification[]): WorkspaceContextValue {
  return {
    activeWorkspaceId: WORKSPACE_ID,
    invalidWorkspace: false,
    sessions: [],
    selectedSession: null,
    assignments: [],
    roleId: null,
    setRoleId: () => {},
    offices: [],
    desks: [],
    reports: [],
    now: 1_700_000_000_000,
    wakingAgents: new Set(),
    showSystem: false,
    setShowSystem: () => {},
    configOpen: false,
    focusSession: () => {},
    endSession: async () => {},
    resumeSession: async () => {},
    wakeAgent: async () => {},
    userNotifications,
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

function render(notifications: readonly Notification[] = [HIGH_NOTIF, LOW_NOTIF]) {
  act(() => {
    root.render(
      <WorkspaceProvider value={makeWorkspace(notifications)}>
        <InboxView />
      </WorkspaceProvider>,
    );
  });
}

describe("InboxView — notification list", () => {
  it("renders both notifications from context", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("High priority push");
    expect(text).toContain("Low priority note");
  });

  it("high-priority row carries data-priority='high'", () => {
    render();
    const highRows = container.querySelectorAll("[data-priority='high']");
    expect(highRows.length).toBeGreaterThanOrEqual(1);
  });

  it("low-priority row carries data-priority='low'", () => {
    render();
    const lowRows = container.querySelectorAll("[data-priority='low']");
    expect(lowRows.length).toBeGreaterThanOrEqual(1);
  });

  it("empty state when no notifications", () => {
    render([]);
    expect(container.textContent).toContain("No unread");
  });
});

describe("InboxView — detail inspector (real wire shape)", () => {
  it("inspector shows all fields when a row is clicked", async () => {
    render([HIGH_NOTIF]);
    const rows = container.querySelectorAll("[data-notification-id]");
    expect(rows.length).toBeGreaterThan(0);

    await act(async () => {
      (rows[0] as HTMLElement).click();
    });

    const text = container.textContent ?? "";
    // id and type visible in inspector
    expect(text).toContain("notif-high");
    expect(text).toContain("push");
    // provenance source_kind
    expect(text).toContain("push");
    // metadata key visible
    expect(text).toContain("ref");
  });

  it("inspector shows payload body on select", async () => {
    render([HIGH_NOTIF]);

    await act(async () => {
      (container.querySelector("[data-notification-id]") as HTMLElement).click();
    });

    expect(container.textContent).toContain("High priority push");
  });

  it("inspector renders notification with empty metadata without crashing", async () => {
    render([LOW_NOTIF]);

    await act(async () => {
      (container.querySelector("[data-notification-id]") as HTMLElement).click();
    });

    expect(container.textContent).toContain("Low priority note");
  });

  it("inspector shows notification with delivery_mode and acked_at fields", async () => {
    const withMeta = makeNotification({
      id: "notif-full",
      delivery_mode: "quiet",
      acked_at: 1_700_000_001_000,
      metadata: { run_id: "99" },
      payload: { body: "full shape test", tag: STUB_TAG },
    });
    render([withMeta]);

    await act(async () => {
      (container.querySelector("[data-notification-id]") as HTMLElement).click();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("quiet");
    expect(text).toContain("run_id");
  });

  it("clicking the same row again collapses the inspector", async () => {
    render([HIGH_NOTIF]);
    const row = container.querySelector("[data-notification-id]") as HTMLElement;

    await act(async () => { row.click(); });
    expect(container.querySelector("[data-action='ack']")).not.toBeNull();

    await act(async () => { row.click(); });
    expect(container.querySelector("[data-action='ack']")).toBeNull();
  });
});

describe("InboxView — ack from panel", () => {
  it("ack button appears in inspector after selecting a row", async () => {
    render();
    await act(async () => {
      (container.querySelector("[data-notification-id]") as HTMLElement).click();
    });
    expect(container.querySelector("[data-action='ack']")).not.toBeNull();
  });

  it("clicking ack calls POST /notifications/:id/ack for the selected row", async () => {
    render([HIGH_NOTIF]);
    await act(async () => {
      (container.querySelector("[data-notification-id]") as HTMLElement).click();
    });
    await act(async () => {
      (container.querySelector("[data-action='ack']") as HTMLElement).click();
    });
    expect(postedAckId).toBe("notif-high");
  });
});
