import { describe, it, expect } from "bun:test";
import { ModelSchema, MODEL_ALIASES } from "../src/domain/model.ts";

describe("ModelSchema", () => {
  it("accepts all MODEL_ALIASES", () => {
    for (const alias of MODEL_ALIASES) {
      const result = ModelSchema.safeParse(alias);
      expect(result.success).toBe(true);
    }
  });

  it("accepts a full claude-* API name", () => {
    const result = ModelSchema.safeParse("claude-opus-4-8");
    expect(result.success).toBe(true);
  });

  it("rejects an unknown alias", () => {
    const result = ModelSchema.safeParse("gpt-4o");
    expect(result.success).toBe(false);
  });

  it("includes fable as a valid alias", () => {
    expect(MODEL_ALIASES).toContain("fable");
    const result = ModelSchema.safeParse("fable");
    expect(result.success).toBe(true);
  });
});
