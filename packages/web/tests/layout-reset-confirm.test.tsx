import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { defaultLayout } from "../src/layout/default-layout.ts";
import { saveLayout } from "../src/layout/persistence.ts";
import { layoutReducer } from "../src/layout/reducer.ts";

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
let confirmCalls: string[];
let confirmReturn: boolean;
const originalConfirm = globalThis.confirm;

beforeEach(() => {
  localStorage.clear();
  confirmCalls = [];
  confirmReturn = true;
  (globalThis as unknown as { confirm: (msg?: string) => boolean }).confirm = (
    msg?: string,
  ) => {
    confirmCalls.push(msg ?? "");
    return confirmReturn;
  };
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
  (globalThis as unknown as { confirm: typeof originalConfirm }).confirm =
    originalConfirm;
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

async function clickReset() {
  const menuBtn = container.querySelector<HTMLButtonElement>(
    '[aria-label="Layout menu"]',
  );
  if (menuBtn === null) throw new Error("layout menu button missing");
  await act(async () => {
    menuBtn.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
  const items = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  );
  const reset = items.find((b) => b.textContent?.trim() === "Reset layout");
  if (reset === undefined) throw new Error("Reset layout menu item missing");
  await act(async () => {
    reset.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

describe("reset-layout confirmation (#281)", () => {
  it("does NOT prompt when current layout is already the default", async () => {
    await renderAt("/w/workspace-a");
    await clickReset();
    await flush();
    expect(confirmCalls.length).toBe(0);
  });

  it("prompts when current layout differs from default, and resets on accept", async () => {
    const customized = layoutReducer(defaultLayout(), {
      kind: "resize",
      splitPath: [],
      sizes: [0.1, 0.7, 0.2],
      containerPx: 1000,
    });
    saveLayout("workspace-a", customized);

    await renderAt("/w/workspace-a");
    confirmReturn = true;
    await clickReset();
    await flush();
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]).toBe(
      "Reset layout? Your current arrangement will be lost.",
    );
    const restored = JSON.parse(
      localStorage.getItem("clobber:layout:v2:workspace-a") ?? "null",
    );
    expect(restored).toEqual(defaultLayout());
  });

  it("does not reset when the user cancels the confirm", async () => {
    const customized = layoutReducer(defaultLayout(), {
      kind: "resize",
      splitPath: [],
      sizes: [0.1, 0.7, 0.2],
      containerPx: 1000,
    });
    saveLayout("workspace-a", customized);

    await renderAt("/w/workspace-a");
    confirmReturn = false;
    await clickReset();
    await flush();
    expect(confirmCalls.length).toBe(1);
    const stored = JSON.parse(
      localStorage.getItem("clobber:layout:v2:workspace-a") ?? "null",
    );
    expect(stored).toEqual(customized);
  });
});
