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
import { TranscriptViewer } from "../src/components/TranscriptViewer.tsx";

const toolUseLine = (name: string, input: unknown, id = "toolu_1") => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  },
});

describe("TranscriptViewer: file diff blocks for Edit/Write (#684)", () => {
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

  it("renders a colored diff with the file path for an Edit block, without expanding details", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[
            toolUseLine("Edit", {
              file_path: "/repo/src/foo.ts",
              old_string: "const a = 1;",
              new_string: "const a = 2;",
            }),
          ]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.textContent).toContain("/repo/src/foo.ts");
    const removed = container.querySelector('[data-diff-line="remove"]');
    const added = container.querySelector('[data-diff-line="add"]');
    expect(removed?.textContent).toContain("const a = 1;");
    expect(added?.textContent).toContain("const a = 2;");
    // raw JSON must not be shown without show-details
    expect(container.textContent).not.toContain('"old_string"');
  });

  it("shows unchanged context lines around a small edit without marking them add/remove", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[
            toolUseLine("Edit", {
              file_path: "/repo/src/foo.ts",
              old_string: "line1\nline2\nline3",
              new_string: "line1\nCHANGED\nline3",
            }),
          ]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    const context = container.querySelectorAll('[data-diff-line="context"]');
    expect(context.length).toBeGreaterThanOrEqual(2);
  });

  it("still reveals the raw JSON input for an Edit block when show-details is on", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[
            toolUseLine("Edit", {
              file_path: "/repo/src/foo.ts",
              old_string: "const a = 1;",
              new_string: "const a = 2;",
            }),
          ]}
          showSystem={true}
          busy={false}
        />,
      );
    });
    expect(container.textContent).toContain('"old_string"');
  });

  it("renders a Write block as an all-additions diff with the file path", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[
            toolUseLine("Write", {
              file_path: "/repo/src/new-file.ts",
              content: "export const x = 1;\nexport const y = 2;",
            }),
          ]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.textContent).toContain("/repo/src/new-file.ts");
    const added = container.querySelectorAll('[data-diff-line="add"]');
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[data-diff-line="remove"]')).toBeNull();
  });

  it("bounds a very large Write payload with a show-full affordance", () => {
    const bigContent = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[
            toolUseLine("Write", {
              file_path: "/repo/src/big.ts",
              content: bigContent,
            }),
          ]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.textContent?.toLowerCase()).toContain("show full");
  });

  it("leaves a non-file tool (Bash) rendering exactly as before — no diff block", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[toolUseLine("Bash", { command: "npm test" })]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.querySelector('[data-diff-line]')).toBeNull();
    expect(container.textContent).toContain("npm test");
  });

  it("falls through to the generic card when Edit-named input doesn't match the diff shape", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[toolUseLine("Edit", { target: "something-else" })]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.querySelector('[data-diff-line]')).toBeNull();
    expect(container.textContent).toContain("something-else");
  });
});
