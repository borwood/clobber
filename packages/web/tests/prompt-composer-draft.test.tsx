import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptComposer } from "../src/components/PromptComposer.tsx";
import { getDraft } from "../src/draft-store.ts";

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
  });
}

function reactProps(el: Element): Record<string, unknown> {
  const elAsMap = el as unknown as Record<string, unknown>;
  const fiberKey = Object.keys(elAsMap).find((k) => k.startsWith("__reactFiber"));
  const fiber = fiberKey !== undefined ? elAsMap[fiberKey] : undefined;
  if (fiber === undefined) throw new Error("no React fiber on element");
  return (fiber as { memoizedProps: Record<string, unknown> }).memoizedProps;
}

async function typeIntoTextarea(textarea: Element, value: string) {
  const onChange = reactProps(textarea).onChange as (e: { target: { value: string } }) => void;
  await act(async () => {
    onChange({ target: { value } });
  });
}

const textareaValue = () => (container.querySelector("textarea") as HTMLTextAreaElement).value;

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
    await typeIntoTextarea(container.querySelector("textarea")!, "half-written thought");

    await tabAwayAndBack(makeComposer("draft-session-a", noop));

    expect(textareaValue()).toBe("half-written thought");
  });

  it("keeps drafts isolated per session", async () => {
    await act(async () => { root.render(makeComposer("draft-session-b", noop)); });
    await typeIntoTextarea(container.querySelector("textarea")!, "for session b");

    await tabAwayAndBack(makeComposer("draft-session-c", noop));

    expect(textareaValue()).toBe("");
  });

  it("clears the draft after a successful send", async () => {
    await act(async () => { root.render(makeComposer("draft-session-d", noop)); });
    await typeIntoTextarea(container.querySelector("textarea")!, "send me");
    expect(getDraft("draft-session-d")).toBe("send me");

    const send = container.querySelector("button[class*='accent']") as HTMLButtonElement;
    await act(async () => {
      send.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(getDraft("draft-session-d")).toBe("");

    await tabAwayAndBack(makeComposer("draft-session-d", noop));

    expect(textareaValue()).toBe("");
  });
});
