import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { classifyLine } from "../src/transcript-types.ts";
import { TranscriptViewer } from "../src/components/TranscriptViewer.tsx";

const PROMPT = "ROLE FRAMING\nYou are a worker.\n[Assignment] ship #253";
const LINE = { type: "system-prompt", prompt: PROMPT };

describe("classifyLine: system-prompt (#253)", () => {
  it("classifies a system-prompt line as kind: system", () => {
    const c = classifyLine(LINE);
    expect(c.kind).toBe("system");
    if (c.kind !== "system") return;
    expect(c.type).toBe("system-prompt");
  });
});

describe("TranscriptViewer: system-prompt entry gated on showSystem (#253)", () => {
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

  it("hides the composed prompt when showSystem is false", () => {
    act(() => {
      root.render(
        <TranscriptViewer lines={[LINE]} showSystem={false} busy={false} />,
      );
    });
    expect(container.textContent).not.toContain(PROMPT);
  });

  it("shows the composed prompt when showSystem is true", () => {
    act(() => {
      root.render(
        <TranscriptViewer lines={[LINE]} showSystem={true} busy={false} />,
      );
    });
    expect(container.textContent).toContain(PROMPT);
  });
});
