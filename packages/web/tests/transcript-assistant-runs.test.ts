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

const SHOW_SYSTEM = { showSystem: true };
const HIDE_SYSTEM = { showSystem: false };

describe("shouldShowAssistantLabel", () => {
  it("first assistant in a transcript shows the label", () => {
    const c = classify(assistantLine("hi"));
    expect(shouldShowAssistantLabel(c, 0, HIDE_SYSTEM)).toBe(true);
  });

  it("a run of consecutive assistants shows the label only on the first", () => {
    const c = classify(
      assistantLine("one"),
      assistantLine("two"),
      assistantLine("three"),
    );
    expect(shouldShowAssistantLabel(c, 0, HIDE_SYSTEM)).toBe(true);
    expect(shouldShowAssistantLabel(c, 1, HIDE_SYSTEM)).toBe(false);
    expect(shouldShowAssistantLabel(c, 2, HIDE_SYSTEM)).toBe(false);
  });

  it("a user message between assistants resets the run", () => {
    const c = classify(
      assistantLine("a"),
      userLine,
      assistantLine("b"),
      assistantLine("c"),
    );
    expect(shouldShowAssistantLabel(c, 0, HIDE_SYSTEM)).toBe(true);
    expect(shouldShowAssistantLabel(c, 2, HIDE_SYSTEM)).toBe(true);
    expect(shouldShowAssistantLabel(c, 3, HIDE_SYSTEM)).toBe(false);
  });

  it("a tool_result is INVISIBLE when showSystem=false → does not reset the run", () => {
    const c = classify(assistantLine("a"), toolResultLine, assistantLine("b"));
    expect(shouldShowAssistantLabel(c, 2, HIDE_SYSTEM)).toBe(false);
  });

  it("a tool_result IS visible when showSystem=true → resets the run", () => {
    const c = classify(assistantLine("a"), toolResultLine, assistantLine("b"));
    expect(shouldShowAssistantLabel(c, 2, SHOW_SYSTEM)).toBe(true);
  });

  it("a filtered line does NOT reset the run (it's invisible regardless of showSystem)", () => {
    const c = classify(assistantLine("a"), filteredLine, assistantLine("b"));
    expect(shouldShowAssistantLabel(c, 2, HIDE_SYSTEM)).toBe(false);
    expect(shouldShowAssistantLabel(c, 2, SHOW_SYSTEM)).toBe(false);
  });

  it("multiple intermediate hidden system lines collapse together (showSystem=false)", () => {
    const c = classify(
      assistantLine("a"),
      toolResultLine,
      toolResultLine,
      toolResultLine,
      assistantLine("b"),
      toolResultLine,
      assistantLine("c"),
    );
    expect(shouldShowAssistantLabel(c, 0, HIDE_SYSTEM)).toBe(true);
    expect(shouldShowAssistantLabel(c, 4, HIDE_SYSTEM)).toBe(false);
    expect(shouldShowAssistantLabel(c, 6, HIDE_SYSTEM)).toBe(false);
  });
});
