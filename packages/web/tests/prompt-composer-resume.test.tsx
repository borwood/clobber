import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptComposer } from "../src/components/PromptComposer.tsx";
import { setDraft } from "../src/draft-store.ts";
import { pressKey, typeInto } from "./cm-editor-harness.ts";

// Stub api.getSessionLocations so openFileBrowser never fails.
import { api } from "../src/api.ts";
(api as { getSessionLocations: unknown }).getSessionLocations = async () => ({
  desk_path: null,
  office_path: null,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // These tests reuse one sessionId and assume a fresh empty composer each
  // time; clear the per-session draft so one test's typed text can't restore
  // into the next mount.
  setDraft("test-session-id", "");
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function noop(): Promise<void> {
  return Promise.resolve();
}

function makeComposer(
  ended: boolean,
  onSend: (p: string) => Promise<void>,
  onResume: (p?: string) => Promise<void>,
) {
  return createElement(PromptComposer, {
    sessionId: "test-session-id",
    ended,
    busy: false,
    showDetails: false,
    onToggleShowDetails: noop,
    onSend,
    onResume,
    onInterrupt: noop,
    onEndSession: noop,
    onReconfigure: noop,
  });
}

// Ctrl+Enter is the send chord now — a bare Enter inserts a line break.
async function pressSend() {
  await pressKey(container, { key: "Enter", ctrlKey: true });
}

describe("PromptComposer resume behavior (#478)", () => {
  it("live session renders 'Send' button", async () => {
    await act(async () => { root.render(makeComposer(false, noop, noop)); });
    const btn = container.querySelector("button[class*='accent']");
    expect(btn?.textContent).toBe("Send");
  });

  it("ended + empty composer renders 'Resume' button", async () => {
    await act(async () => { root.render(makeComposer(true, noop, noop)); });
    const btn = container.querySelector("button[class*='accent']");
    expect(btn?.textContent).toBe("Resume");
  });

  it("ended + text in composer renders 'Resume + Send' button", async () => {
    await act(async () => { root.render(makeComposer(true, noop, noop)); });
    await typeInto(container, "hello there");
    const btn = container.querySelector("button[class*='accent']");
    expect(btn?.textContent).toBe("Resume + Send");
  });

  it("ended + empty: clicking Resume calls onResume(undefined)", async () => {
    let resumeArg: string | undefined = "not-called";
    const onResume = async (p?: string) => { resumeArg = p; };

    await act(async () => { root.render(makeComposer(true, noop, onResume)); });
    const btn = container.querySelector("button[class*='accent']") as HTMLButtonElement;
    await act(async () => { btn.click(); });

    expect(resumeArg).toBeUndefined();
  });

  it("ended + text: clicking 'Resume + Send' calls onResume(text)", async () => {
    let resumeArg: string | undefined = "not-called";
    const onResume = async (p?: string) => { resumeArg = p; };

    await act(async () => { root.render(makeComposer(true, noop, onResume)); });
    await typeInto(container, "my prompt");
    const btn = container.querySelector("button[class*='accent']") as HTMLButtonElement;
    await act(async () => { btn.click(); });

    expect(resumeArg).toBe("my prompt");
  });

  it("ended session: Ctrl+Enter routes to onResume, not onSend", async () => {
    let sendCalled = false;
    let resumeCalled = false;
    const onSend = async () => { sendCalled = true; };
    const onResume = async () => { resumeCalled = true; };

    await act(async () => { root.render(makeComposer(true, onSend, onResume)); });
    await pressSend();

    expect(sendCalled).toBe(false);
    expect(resumeCalled).toBe(true);
  });

  it("live session: Ctrl+Enter never routes to onResume", async () => {
    let resumeCalled = false;
    const onResume = async () => { resumeCalled = true; };

    await act(async () => { root.render(makeComposer(false, noop, onResume)); });
    await typeInto(container, "hi");
    await pressSend();

    expect(resumeCalled).toBe(false);
  });
});
