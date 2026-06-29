import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptComposer } from "../src/components/PromptComposer.tsx";
import { setDraft } from "../src/draft-store.ts";
import { editorText, getView, pressKey, typeInto } from "./cm-editor-harness.ts";

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
  setDraft("md-session", "");
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function noop(): Promise<void> {
  return Promise.resolve();
}

function makeComposer(over: { onSend?: (p: string) => Promise<void> } = {}) {
  return createElement(PromptComposer, {
    sessionId: "md-session",
    ended: false,
    busy: false,
    showDetails: false,
    onToggleShowDetails: noop,
    onSend: over.onSend ?? noop,
    onResume: noop,
    onInterrupt: noop,
    onEndSession: noop,
  });
}

async function selectAll() {
  const view = getView(container);
  await act(async () => {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  });
}

describe("PromptComposer markdown editing", () => {
  it("toolbar Bold button wraps the selection", async () => {
    await act(async () => { root.render(makeComposer()); });
    await typeInto(container, "word");
    await selectAll();

    const bold = container.querySelector("button[aria-label^='Bold']") as HTMLButtonElement;
    await act(async () => { bold.click(); });

    expect(editorText(container)).toBe("**word**");
  });

  it("toolbar Bulleted-list button prefixes the line", async () => {
    await act(async () => { root.render(makeComposer()); });
    await typeInto(container, "task");
    await selectAll();

    const bullet = container.querySelector("button[aria-label^='Bulleted']") as HTMLButtonElement;
    await act(async () => { bullet.click(); });

    expect(editorText(container)).toBe("- task");
  });

  it("Ctrl+I wraps the selection in italics via the keyboard shortcut", async () => {
    await act(async () => { root.render(makeComposer()); });
    await typeInto(container, "word");
    await selectAll();

    await pressKey(container, { key: "i", ctrlKey: true });

    expect(editorText(container)).toBe("*word*");
  });

  it("Ctrl+Enter sends the current text", async () => {
    const sent: { value: string | null } = { value: null };
    await act(async () => { root.render(makeComposer({ onSend: async (p) => { sent.value = p; } })); });
    await typeInto(container, "ship it");

    await pressKey(container, { key: "Enter", ctrlKey: true });

    expect(sent.value).toBe("ship it");
  });

  it("a bare Enter does not send", async () => {
    let sent = false;
    await act(async () => { root.render(makeComposer({ onSend: async () => { sent = true; } })); });
    await typeInto(container, "line one");

    await pressKey(container, { key: "Enter" });

    expect(sent).toBe(false);
  });
});
