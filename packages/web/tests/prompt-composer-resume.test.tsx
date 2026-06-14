import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptComposer } from "../src/components/PromptComposer.tsx";

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
  });
}

// Access the React fiber's memoizedProps on a DOM node. This lets us invoke
// React event handlers directly without relying on DOM event dispatch, which
// doesn't trigger React's synthetic events in happy-dom.
function reactProps(el: Element): Record<string, unknown> {
  const elAsMap = el as unknown as Record<string, unknown>;
  const fiberKey = Object.keys(elAsMap).find((k) => k.startsWith("__reactFiber"));
  const fiber = fiberKey !== undefined ? elAsMap[fiberKey] : undefined;
  if (fiber === undefined) throw new Error("no React fiber on element");
  return (fiber as { memoizedProps: Record<string, unknown> }).memoizedProps;
}

async function typeIntoTextarea(textarea: Element, value: string) {
  const props = reactProps(textarea);
  const onChange = props.onChange as (e: { target: { value: string } }) => void;
  await act(async () => {
    onChange({ target: { value } });
  });
}

async function pressEnter(textarea: Element) {
  const props = reactProps(textarea);
  const onKeyDown = props.onKeyDown as (e: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    preventDefault: () => void;
  }) => void;
  await act(async () => {
    onKeyDown({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => {} });
    // Flush the async send()/resume() that was fired via `void`.
    await new Promise((r) => setTimeout(r, 10));
  });
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
    const textarea = container.querySelector("textarea")!;
    await typeIntoTextarea(textarea, "hello there");
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
    await typeIntoTextarea(container.querySelector("textarea")!, "my prompt");
    const btn = container.querySelector("button[class*='accent']") as HTMLButtonElement;
    await act(async () => { btn.click(); });

    expect(resumeArg).toBe("my prompt");
  });

  it("ended session: Enter keydown routes to onResume, not onSend", async () => {
    let sendCalled = false;
    let resumeCalled = false;
    const onSend = async () => { sendCalled = true; };
    const onResume = async () => { resumeCalled = true; };

    await act(async () => { root.render(makeComposer(true, onSend, onResume)); });
    await pressEnter(container.querySelector("textarea")!);

    expect(sendCalled).toBe(false);
    expect(resumeCalled).toBe(true);
  });

  it("live session: Enter keydown never routes to onResume", async () => {
    let resumeCalled = false;
    const onResume = async () => { resumeCalled = true; };

    await act(async () => { root.render(makeComposer(false, noop, onResume)); });
    await pressEnter(container.querySelector("textarea")!);

    expect(resumeCalled).toBe(false);
  });
});
