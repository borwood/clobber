import { describe, it, expect } from "bun:test";
import {
  classifyLine,
  shouldShowAssistantLabel,
  type Classified,
} from "../src/transcript-types.ts";

function classify(...lines: object[]): Classified[] {
  return lines.map((l) => classifyLine(l as Record<string, unknown>));
}

const userLine = { type: "user", message: { role: "user", content: "hi" } };
const assistantLine = (text: string) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
  },
});
const filteredLine = {
  type: "user",
  message: { role: "user", content: "[Request interrupted by user]" },
};
const toolResultLine = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
  },
};

describe("shouldShowAssistantLabel", () => {
  it("first assistant in a transcript shows the label", () => {
    const c = classify(assistantLine("hi"));
    expect(shouldShowAssistantLabel(c, 0)).toBe(true);
  });

  it("a run of consecutive assistants shows the label only on the first", () => {
    const c = classify(
      assistantLine("one"),
      assistantLine("two"),
      assistantLine("three"),
    );
    expect(shouldShowAssistantLabel(c, 0)).toBe(true);
    expect(shouldShowAssistantLabel(c, 1)).toBe(false);
    expect(shouldShowAssistantLabel(c, 2)).toBe(false);
  });

  it("a user message between assistants resets the run", () => {
    const c = classify(
      assistantLine("a"),
      userLine,
      assistantLine("b"),
      assistantLine("c"),
    );
    expect(shouldShowAssistantLabel(c, 0)).toBe(true);
    expect(shouldShowAssistantLabel(c, 2)).toBe(true); // restart after user
    expect(shouldShowAssistantLabel(c, 3)).toBe(false);
  });

  it("a tool_result (rendered as system) between assistants resets the run", () => {
    const c = classify(assistantLine("a"), toolResultLine, assistantLine("b"));
    expect(shouldShowAssistantLabel(c, 0)).toBe(true);
    expect(shouldShowAssistantLabel(c, 2)).toBe(true); // tool_result interrupts the run
  });

  it("a filtered line does NOT reset the run (it's invisible)", () => {
    const c = classify(assistantLine("a"), filteredLine, assistantLine("b"));
    expect(shouldShowAssistantLabel(c, 0)).toBe(true);
    expect(shouldShowAssistantLabel(c, 2)).toBe(false); // filter is transparent
  });
});
