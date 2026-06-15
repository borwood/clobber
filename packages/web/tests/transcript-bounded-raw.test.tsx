import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// @tanstack/virtual-core's getRect uses offsetHeight/offsetWidth (not getBoundingClientRect).
// Scroll container (no data-index) → 600px; virtual item wrappers (data-index set) → 50px.
// Without these stubs the virtualizer renders 0 items in happy-dom's no-layout environment.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() { return this.hasAttribute("data-index") ? 50 : 600; },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  NotificationCard,
  SystemLine,
  SystemPromptLine,
} from "../src/components/TranscriptCards.tsx";
import { TranscriptViewer } from "../src/components/TranscriptViewer.tsx";

const LARGE = "x".repeat(200_000);
const LARGE_OBJ = { type: "system", data: LARGE };
const CAP = 20_000; // upper-bound used in assertions (2× the expected 10KB cap)

// A tool_use assistant line with a very large input payload
const bigToolUseLine = () => ({
  type: "assistant",
  message: {
    role: "assistant" as const,
    content: [
      {
        type: "tool_use",
        id: "toolu_big",
        name: "Read",
        input: { file_path: "/big", content: LARGE },
      },
    ],
  },
});

describe("BoundedRaw — NotificationCard (#673)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("truncates a large raw payload to a bounded length when showRaw is on", () => {
    act(() => {
      root.render(
        <NotificationCard
          summary="task done"
          raw={LARGE_OBJ as never}
          showRaw={true}
        />,
      );
    });
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect((pre?.textContent ?? "").length).toBeLessThan(CAP);
  });

  it("shows an expand affordance when the payload has been truncated", () => {
    act(() => {
      root.render(
        <NotificationCard
          summary="task done"
          raw={LARGE_OBJ as never}
          showRaw={true}
        />,
      );
    });
    // A "show full" button or similar expand control must be present
    expect(container.textContent?.toLowerCase()).toContain("show full");
  });

  it("hides the raw pre entirely when showRaw is false", () => {
    act(() => {
      root.render(
        <NotificationCard
          summary="task done"
          raw={LARGE_OBJ as never}
          showRaw={false}
        />,
      );
    });
    expect(container.querySelector("pre")).toBeNull();
  });
});

describe("BoundedRaw — SystemLine (#673)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("truncates large raw when the details are expanded", () => {
    act(() => {
      root.render(
        <SystemLine type="tool_result" summary="1 result" raw={LARGE_OBJ as never} />,
      );
    });
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect((pre?.textContent ?? "").length).toBeLessThan(CAP);
  });

  it("shows an expand affordance for large raw", () => {
    act(() => {
      root.render(
        <SystemLine type="tool_result" raw={LARGE_OBJ as never} />,
      );
    });
    expect(container.textContent?.toLowerCase()).toContain("show full");
  });
});

describe("BoundedRaw — SystemPromptLine (#673)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("truncates a very long system prompt string", () => {
    const raw = { type: "system-prompt", prompt: LARGE };
    act(() => {
      root.render(<SystemPromptLine raw={raw as never} />);
    });
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect((pre?.textContent ?? "").length).toBeLessThan(CAP);
  });

  it("shows an expand affordance for a long prompt", () => {
    const raw = { type: "system-prompt", prompt: LARGE };
    act(() => {
      root.render(<SystemPromptLine raw={raw as never} />);
    });
    expect(container.textContent?.toLowerCase()).toContain("show full");
  });
});

describe("BoundedRaw — ToolCallCard input dump via TranscriptViewer (#673)", () => {
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

  it("truncates the full JSON input in show-details mode", () => {
    act(() => {
      root.render(
        <TranscriptViewer lines={[bigToolUseLine()]} showSystem={true} busy={false} />,
      );
    });
    const pres = container.querySelectorAll("pre");
    // At least one pre element must be present (the tool input dump)
    expect(pres.length).toBeGreaterThan(0);
    for (const pre of pres) {
      expect((pre.textContent ?? "").length).toBeLessThan(CAP);
    }
  });

  it("shows an expand affordance for a large tool input", () => {
    act(() => {
      root.render(
        <TranscriptViewer lines={[bigToolUseLine()]} showSystem={true} busy={false} />,
      );
    });
    expect(container.textContent?.toLowerCase()).toContain("show full");
  });
});
