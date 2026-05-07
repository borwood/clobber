import { describe, it, expect } from "bun:test";
import { previewToolInput } from "../src/transcript-types.ts";

describe("previewToolInput", () => {
  it("returns file_path for Read-style inputs", () => {
    expect(previewToolInput({ file_path: "/repo/src/foo.ts" })).toBe(
      "/repo/src/foo.ts",
    );
  });

  it("prefers command over description for Bash", () => {
    expect(
      previewToolInput({ command: "npm test", description: "run unit tests" }),
    ).toBe("npm test");
  });

  it("returns pattern for Grep/Glob", () => {
    expect(previewToolInput({ pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("returns description as a fallback when no canonical field is set", () => {
    expect(
      previewToolInput({
        description: "look up prior session",
        subagent_type: "Explore",
      }),
    ).toBe("look up prior session");
  });

  it("returns prompt when present (e.g. Task)", () => {
    expect(previewToolInput({ prompt: "find files matching X" })).toBe(
      "find files matching X",
    );
  });

  it("falls back to first non-empty string value when no priority key matches", () => {
    expect(previewToolInput({ unknown_field: "hello world" })).toBe("hello world");
  });

  it("returns only the first line of multi-line values", () => {
    expect(previewToolInput({ command: "npm test\n--watch\n--bail" })).toBe(
      "npm test",
    );
  });

  it("truncates long values at 120 chars", () => {
    const long = "x".repeat(300);
    const out = previewToolInput({ command: long })!;
    expect(out.length).toBe(120);
  });

  it("returns null for an empty input object", () => {
    expect(previewToolInput({})).toBeNull();
  });

  it("returns null for non-object inputs", () => {
    expect(previewToolInput(null)).toBeNull();
    expect(previewToolInput("not an object")).toBeNull();
    expect(previewToolInput(42)).toBeNull();
  });

  it("ignores empty-string values when picking", () => {
    expect(
      previewToolInput({ file_path: "", command: "ls -la" }),
    ).toBe("ls -la");
  });
});
