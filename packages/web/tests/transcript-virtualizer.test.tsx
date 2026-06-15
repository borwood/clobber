// Tests for #672: TranscriptViewer virtualization with @tanstack/react-virtual.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// @tanstack/virtual-core's getRect uses offsetHeight/offsetWidth (not getBoundingClientRect).
// happy-dom returns 0 for both. Two distinct values prevent an infinite remeasure loop:
// - scroll CONTAINER (no data-index): 600px → virtualizer has a viewport to fill
// - virtual item WRAPPERS (data-index set): 50px → stable; 600/50 + overscan ≈ 17 rows
// If items also returned 600px, each item would fill the entire viewport → the virtualizer
// would repeatedly recalculate and hit React's "maximum update depth" limit.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() { return this.hasAttribute("data-index") ? 50 : 600; },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
// scrollToIndex calls element.scrollTo({ top: X }) which in happy-dom fires a scroll event
// and triggers the virtualizer's measurement cascade. Stub as no-op so the initial window
// (items 0-16) stays stable; scroll-position tests don't exist here so this is safe.
HTMLElement.prototype.scrollTo = () => {};

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TranscriptViewer } from "../src/components/TranscriptViewer.tsx";

const userLine = (i: number) => ({
  type: "user" as const,
  message: { role: "user" as const, content: `Message ${i}` },
});

// A user turn whose content is all tool_result blocks — classifyLine yields kind:"system"
// so it only renders when showSystem=true.
const toolResultSystemLine = () => ({
  type: "user",
  message: {
    role: "user" as const,
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "result body" },
    ],
  },
});

// A line that classifyLine filters entirely (interrupt marker) — never renders
const interruptLine = () => ({
  type: "user",
  message: { role: "user" as const, content: "[Request interrupted by user]" },
});

describe("#672: TranscriptViewer windowing — large transcript renders bounded subset", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("mounts far fewer than 1000 DOM rows for a 1000-line transcript", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => userLine(i));
    act(() => {
      root.render(
        <TranscriptViewer lines={lines} showSystem={false} busy={false} />,
      );
    });
    // With virtualization, only the initial overscan window renders.
    // Without virtualization, all 1000 UserCard elements mount.
    const bubbles = container.querySelectorAll(".bg-elevated.border-border-strong");
    expect(bubbles.length).toBeGreaterThan(0);
    expect(bubbles.length).toBeLessThan(50);
  });
});

describe("#672: TranscriptViewer filtering — showSystem gates system lines", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("hides tool_result system lines when showSystem is false", () => {
    const lines = [userLine(0), toolResultSystemLine()];
    act(() => {
      root.render(<TranscriptViewer lines={lines} showSystem={false} busy={false} />);
    });
    // system lines render as <details> via SystemLine; none should be present
    expect(container.querySelectorAll("details").length).toBe(0);
  });

  it("shows tool_result system lines when showSystem is true", () => {
    const lines = [userLine(0), toolResultSystemLine()];
    act(() => {
      root.render(<TranscriptViewer lines={lines} showSystem={true} busy={false} />);
    });
    expect(container.querySelectorAll("details").length).toBeGreaterThan(0);
  });

  it("never renders filtered lines (interrupt marker) regardless of showSystem", () => {
    const lines = [interruptLine()];
    act(() => {
      root.render(<TranscriptViewer lines={lines} showSystem={true} busy={false} />);
    });
    expect(container.textContent).not.toContain("[Request interrupted by user]");
  });

  it("re-renders feed correctly when showSystem toggles on an existing transcript", () => {
    const lines = [userLine(0), toolResultSystemLine(), userLine(1)];
    act(() => {
      root.render(<TranscriptViewer lines={lines} showSystem={false} busy={false} />);
    });
    const countOff = container.querySelectorAll("details").length;

    act(() => {
      root.render(<TranscriptViewer lines={lines} showSystem={true} busy={false} />);
    });
    const countOn = container.querySelectorAll("details").length;

    expect(countOn).toBeGreaterThan(countOff);
  });
});

describe("#672: TranscriptViewer pin/jump — initial state and unpinned button", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
  });

  it("shows no jump-to-latest button when initially pinned", () => {
    act(() => {
      root.render(<TranscriptViewer lines={[userLine(0)]} showSystem={false} busy={false} />);
    });
    // The jump button only appears when pinned=false
    expect(container.textContent).not.toContain("jump to latest");
  });

  it("always shows user content regardless of viewport size", () => {
    act(() => {
      root.render(
        <TranscriptViewer lines={[userLine(0), userLine(1)]} showSystem={false} busy={false} />,
      );
    });
    // With only 2 lines the virtualizer renders both (within overscan); content must be visible
    expect(container.textContent).toContain("Message 0");
    expect(container.textContent).toContain("Message 1");
  });
});
