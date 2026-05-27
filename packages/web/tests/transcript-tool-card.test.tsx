import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const toolResultLine = (toolUseId: string, isError: boolean) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "result body",
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});

describe("TranscriptViewer: tool-call summary cards (#40)", () => {
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

  it("renders a compact summary (name + identifying input) when show-details is off", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[toolUseLine("Read", { file_path: "/repo/src/foo.ts" })]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.textContent).toContain("Read");
    expect(container.textContent).toContain("/repo/src/foo.ts");
    // The raw JSON payload (the literal key) must NOT be shown by default.
    expect(container.textContent).not.toContain('"file_path"');
  });

  it("falls back to the full JSON payload when show-details is on", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[toolUseLine("Read", { file_path: "/repo/src/foo.ts" })]}
          showSystem={true}
          busy={false}
        />,
      );
    });
    expect(container.textContent).toContain('"file_path"');
  });

  it("is generic — an unknown tool shows its name and first identifying field with no special-casing", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[toolUseLine("BrandNewTool", { target: "the-thing" })]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.textContent).toContain("BrandNewTool");
    expect(container.textContent).toContain("the-thing");
  });

  it("shows a running status when no tool_result has landed yet", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[toolUseLine("Bash", { command: "npm test" })]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
  });

  it("shows an ok status when a non-error tool_result correlates by id", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[
            toolUseLine("Bash", { command: "npm test" }, "toolu_ok"),
            toolResultLine("toolu_ok", false),
          ]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.querySelector('[data-status="ok"]')).not.toBeNull();
  });

  it("shows an error status when the correlating tool_result is an error", () => {
    act(() => {
      root.render(
        <TranscriptViewer
          lines={[
            toolUseLine("Bash", { command: "npm test" }, "toolu_err"),
            toolResultLine("toolu_err", true),
          ]}
          showSystem={false}
          busy={false}
        />,
      );
    });
    expect(container.querySelector('[data-status="error"]')).not.toBeNull();
  });
});
