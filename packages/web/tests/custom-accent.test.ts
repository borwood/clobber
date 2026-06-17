import { describe, it, expect } from "bun:test";
import { WorkspaceThemeSchema } from "@clobber/shared";
import { customAccentProps } from "../src/lib/apply-theme.ts";

describe("custom accent", () => {
  it("WorkspaceThemeSchema accepts a custom-color accent and a built-in alike", () => {
    const builtin = WorkspaceThemeSchema.parse({
      mode: "dark",
      accent: "emerald",
      custom: [],
      pfpSize: "medium",
    });
    expect(builtin.accent).toBe("emerald");

    const custom = WorkspaceThemeSchema.parse({
      mode: "dark",
      accent: { kind: "custom", color: "#ff8800" },
      custom: [],
      pfpSize: "medium",
    });
    expect(custom.accent).toEqual({ kind: "custom", color: "#ff8800" });
  });

  it("rejects a custom accent whose color fails the CSS-color guard", () => {
    const bad = WorkspaceThemeSchema.safeParse({
      mode: "dark",
      accent: { kind: "custom", color: "url(evil);" },
      custom: [],
      pfpSize: "medium",
    });
    expect(bad.success).toBe(false);
  });

  it("derives the full 6-step ramp from the seed color via relative-color oklch", () => {
    const props = customAccentProps("#ff8800");
    expect(Object.keys(props).sort()).toEqual(
      ["accent", "accent-deep", "accent-hover", "accent-muted", "accent-strong", "accent-text"].sort(),
    );
    // every step re-hues from the seed (h keyword) at its own lightness/chroma
    expect(props.accent).toBe("oklch(from #ff8800 0.596 0.145 h)");
    expect(props["accent-strong"]).toBe("oklch(from #ff8800 0.508 0.118 h)");
    for (const v of Object.values(props)) {
      expect(v).toContain("from #ff8800");
      expect(v.endsWith(" h)")).toBe(true);
    }
  });
});
