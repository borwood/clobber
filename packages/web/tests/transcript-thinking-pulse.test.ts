import { describe, it, expect } from "bun:test";
import { classifyLine } from "../src/transcript-types.ts";

const thinkingOnlyAssistant = (timestamp = "2026-05-07T00:00:00Z") => ({
  type: "assistant",
  timestamp,
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "", signature: "abc" }],
  },
});

const assistantWithText = (text: string) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
  },
});

const assistantWithThinkingContent = (text: string) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "real reasoning here", signature: "x" },
      { type: "text", text },
    ],
  },
});

describe("classifyLine: thinking-pulse", () => {
  it("classifies a thinking-only assistant line (empty thinking, signature) as kind: thinking-pulse", () => {
    const c = classifyLine(thinkingOnlyAssistant() as Record<string, unknown>);
    expect(c.kind).toBe("thinking-pulse");
    if (c.kind !== "thinking-pulse") return;
    expect(c.timestamp).toBe(new Date("2026-05-07T00:00:00Z").getTime());
  });

  it("classifies an assistant with both thinking AND text as kind: assistant (renders normally)", () => {
    const c = classifyLine(assistantWithThinkingContent("hello") as Record<string, unknown>);
    expect(c.kind).toBe("assistant");
  });

  it("classifies a normal text-only assistant as kind: assistant", () => {
    const c = classifyLine(assistantWithText("hello") as Record<string, unknown>);
    expect(c.kind).toBe("assistant");
  });

  it("returns timestamp=null when the timestamp field is missing or unparseable", () => {
    const line = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", signature: "x" }],
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("thinking-pulse");
    if (c.kind !== "thinking-pulse") return;
    expect(c.timestamp).toBeNull();
  });
});
