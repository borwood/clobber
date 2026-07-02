import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptComposer } from "../src/components/PromptComposer.tsx";
import { getDraft } from "../src/draft-store.ts";
import { editorText, typeInto } from "./cm-editor-harness.ts";

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
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function noop(): Promise<void> {
  return Promise.resolve();
}

function makeComposer(sessionId: string, onSend: (p: string) => Promise<void>) {
  return createElement(PromptComposer, {
    sessionId,
    ended: false,
    busy: false,
    showDetails: false,
    onToggleShowDetails: noop,
    onSend,
    onResume: noop,
    onInterrupt: noop,
    onEndSession: noop,
    onReconfigure: noop,
  });
}

// A tab switch fully unmounts the composer (only the active pane renders, and
// it's keyed per session). Model that: drop the composer, then mount it fresh
// so its useState initializer re-reads the draft store.
async function tabAwayAndBack(node: ReturnType<typeof makeComposer>) {
  await act(async () => { root.render(createElement("div")); });
  await act(async () => { root.render(node); });
}

describe("PromptComposer draft retention", () => {
  it("restores an unsent draft when the composer remounts for the same session", async () => {
    await act(async () => { root.render(makeComposer("draft-session-a", noop)); });
    await typeInto(container, "half-written thought");

    await tabAwayAndBack(makeComposer("draft-session-a", noop));

    expect(editorText(container)).toBe("half-written thought");
  });

  it("keeps drafts isolated per session", async () => {
    await act(async () => { root.render(makeComposer("draft-session-b", noop)); });
    await typeInto(container, "for session b");

    await tabAwayAndBack(makeComposer("draft-session-c", noop));

    expect(editorText(container)).toBe("");
  });

  it("clears the draft after a successful send", async () => {
    await act(async () => { root.render(makeComposer("draft-session-d", noop)); });
    await typeInto(container, "send me");
    expect(getDraft("draft-session-d")).toBe("send me");

    const send = container.querySelector("button[class*='accent']") as HTMLButtonElement;
    await act(async () => {
      send.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(getDraft("draft-session-d")).toBe("");

    await tabAwayAndBack(makeComposer("draft-session-d", noop));

    expect(editorText(container)).toBe("");
  });
});
