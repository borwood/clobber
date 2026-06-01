import { describe, it, expect } from "bun:test";
import { computeContextLength } from "../src/context-length.ts";
import type { TranscriptLine } from "../src/api.ts";

describe("computeContextLength", () => {
  it("returns undefined when there are no transcript lines", () => {
    expect(computeContextLength([])).toBeUndefined();
  });

  it("returns undefined when there are no assistant turns", () => {
    const lines: TranscriptLine[] = [
      { type: "user", message: { role: "user", content: "hello" } },
    ];
    expect(computeContextLength(lines)).toBeUndefined();
  });

  it("returns undefined when the assistant turn has no usage field", () => {
    const lines: TranscriptLine[] = [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ];
    expect(computeContextLength(lines)).toBeUndefined();
  });

  it("sums input_tokens, cache_read_input_tokens, and cache_creation_input_tokens", () => {
    const lines: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
            output_tokens: 50,
          },
        },
      },
    ];
    expect(computeContextLength(lines)).toBe(1700);
  });

  it("uses only input_tokens when cache fields are absent", () => {
    const lines: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 2000, output_tokens: 100 },
        },
      },
    ];
    expect(computeContextLength(lines)).toBe(2000);
  });

  it("uses the last assistant turn's usage, not the first", () => {
    const lines: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
      },
      { type: "user", message: { role: "user", content: "follow-up" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 5000, cache_read_input_tokens: 1000, output_tokens: 80 },
        },
      },
    ];
    expect(computeContextLength(lines)).toBe(6000);
  });
});
