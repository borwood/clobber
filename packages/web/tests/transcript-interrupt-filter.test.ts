import { describe, it, expect } from "bun:test";
import { classifyLine } from "../src/transcript-types.ts";

describe("classifyLine: filters claude's '[Request interrupted by user]' synthetic line", () => {
  it("classifies the exact phrase (string content) as kind: filtered", () => {
    const line = {
      type: "user",
      message: { role: "user", content: "[Request interrupted by user]" },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("filtered");
  });

  it("classifies the exact phrase inside a single text block as kind: filtered", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("filtered");
  });

  it("matches even with surrounding whitespace (trimmed comparison)", () => {
    const line = {
      type: "user",
      message: { role: "user", content: "  [Request interrupted by user]  \n" },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("filtered");
  });

  it("does NOT filter a regular user message that mentions the phrase in context", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: "earlier i saw [Request interrupted by user] and wondered",
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("user");
  });
});
