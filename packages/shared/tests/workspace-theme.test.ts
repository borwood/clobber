import { describe, it, expect } from "bun:test";
import {
  CssColorSchema,
  CustomThemeSchema,
  SemanticTokenSchema,
  WorkspaceThemeSchema,
  DEFAULT_WORKSPACE_THEME,
} from "@clobber/shared";

// #370: custom themes are DATA — a stored sparse token map injected as CSS vars.
// The contract here is the trust boundary: a custom theme's color values land in
// `document.documentElement.style`, so CssColorSchema must reject anything that
// could break out of a CSS value (`;`, `url(`), and the token KEYS must be a
// known role (a typo'd token would be a silent dead override otherwise).

describe("CssColorSchema — accepts real colors, rejects injection", () => {
  it("accepts hex / rgb / oklch", () => {
    for (const c of [
      "#fff",
      "#ffffff",
      "#ffffffff",
      "rgb(0 0 0)",
      "rgb(0, 0, 0)",
      "rgb(255 255 255 / 0.5)",
      "oklch(59.6% 0.145 163.225)",
    ]) {
      expect(CssColorSchema.safeParse(c).success).toBe(true);
    }
  });

  it("rejects a ';' break-out", () => {
    expect(CssColorSchema.safeParse("red; background: black").success).toBe(false);
    expect(CssColorSchema.safeParse("#fff;").success).toBe(false);
  });

  it("rejects url(...)", () => {
    expect(CssColorSchema.safeParse("url(https://evil.test/x.png)").success).toBe(false);
    expect(CssColorSchema.safeParse("oklch(50% 0 0) url(x)").success).toBe(false);
  });

  it("rejects a bare keyword (not hex/rgb/oklch)", () => {
    expect(CssColorSchema.safeParse("red").success).toBe(false);
  });
});

describe("SemanticTokenSchema — known role names only", () => {
  it("accepts a real token", () => {
    expect(SemanticTokenSchema.safeParse("bg").success).toBe(true);
    expect(SemanticTokenSchema.safeParse("accent").success).toBe(true);
  });

  it("rejects an unknown token", () => {
    expect(SemanticTokenSchema.safeParse("not-a-token").success).toBe(false);
    expect(SemanticTokenSchema.safeParse("color-bg").success).toBe(false);
  });
});

describe("CustomThemeSchema — sparse overrides + base provenance", () => {
  it("tokens default to an empty (sparse) map", () => {
    const parsed = CustomThemeSchema.parse({ id: "c1", name: "Mine", base: "dark" });
    expect(parsed.tokens).toEqual({});
  });

  it("stores only the overridden tokens (sparse)", () => {
    const parsed = CustomThemeSchema.parse({
      id: "c1",
      name: "Mine",
      base: "light",
      tokens: { bg: "#ffffff", accent: "oklch(60% 0.2 30)" },
    });
    expect(Object.keys(parsed.tokens).sort()).toEqual(["accent", "bg"]);
  });

  it("requires a built-in base (provenance edge)", () => {
    expect(CustomThemeSchema.safeParse({ id: "c1", name: "Mine" }).success).toBe(false);
    expect(
      CustomThemeSchema.safeParse({ id: "c1", name: "Mine", base: "midnight" }).success,
    ).toBe(false);
  });

  it("rejects an unknown token key", () => {
    expect(
      CustomThemeSchema.safeParse({
        id: "c1",
        name: "Mine",
        base: "dark",
        tokens: { bogus: "#fff" },
      }).success,
    ).toBe(false);
  });

  it("rejects an injection-bearing token value", () => {
    expect(
      CustomThemeSchema.safeParse({
        id: "c1",
        name: "Mine",
        base: "dark",
        tokens: { bg: "#fff; background: url(x)" },
      }).success,
    ).toBe(false);
  });
});

describe("WorkspaceThemeSchema — custom id mode + custom array", () => {
  it("custom defaults to an empty array", () => {
    expect(DEFAULT_WORKSPACE_THEME.custom).toEqual([]);
  });

  it("accepts a custom id as mode with the def present", () => {
    const parsed = WorkspaceThemeSchema.parse({
      mode: "c1",
      accent: "emerald",
      custom: [{ id: "c1", name: "Mine", base: "dark", tokens: {} }],
    });
    expect(parsed.mode).toBe("c1");
    expect(parsed.custom).toHaveLength(1);
  });

  it("still accepts a built-in mode", () => {
    const parsed = WorkspaceThemeSchema.parse({ mode: "light", accent: "blue" });
    expect(parsed.mode).toBe("light");
    expect(parsed.custom).toEqual([]);
  });
});
