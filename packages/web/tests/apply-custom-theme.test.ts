import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { WorkspaceTheme } from "@clobber/shared";
import { applyWorkspaceTheme } from "../src/lib/apply-theme.ts";

afterAll(() => {
  GlobalRegistrator.unregister();
});

// #370 web runtime: a custom theme paints by setting `data-theme` to its BASE
// (so it inherits the base's surfaces + contrast overrides), then injecting only
// its overridden tokens as inline `--color-*` props. Un-overridden tokens carry
// NO inline prop, so they resolve through the base's `[data-theme]` block — that
// absence IS the sparse inheritance. Switching themes must clean up stale props.

const root = () => document.documentElement;

function customTheme(): WorkspaceTheme {
  return {
    mode: "c1",
    accent: "emerald",
    custom: [
      {
        id: "c1",
        name: "Midnight Citrus",
        base: "paper",
        accent: "amber",
        tokens: { bg: "#101010", accent: "oklch(70% 0.18 80)" },
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  const s = root().style;
  for (const t of ["bg", "accent", "surface", "text"]) s.removeProperty(`--color-${t}`);
  delete root().dataset.theme;
  delete root().dataset.accent;
});

describe("applyWorkspaceTheme — custom theme", () => {
  it("sets data-theme to the base and data-accent to the custom accent", () => {
    applyWorkspaceTheme(customTheme());
    expect(root().dataset.theme).toBe("paper");
    expect(root().dataset.accent).toBe("amber");
  });

  it("inherits the workspace accent when the custom theme pins none", () => {
    applyWorkspaceTheme({
      mode: "c1",
      accent: "emerald",
      custom: [{ id: "c1", name: "No Accent", base: "paper", tokens: {} }],
    });
    expect(root().dataset.accent).toBe("emerald");
  });

  it("injects inline props ONLY for overridden tokens (sparse)", () => {
    applyWorkspaceTheme(customTheme());
    expect(root().style.getPropertyValue("--color-bg")).toBe("#101010");
    expect(root().style.getPropertyValue("--color-accent")).toBe("oklch(70% 0.18 80)");
    // Un-overridden tokens carry no inline prop → they inherit from [data-theme=paper].
    expect(root().style.getPropertyValue("--color-surface")).toBe("");
    expect(root().style.getPropertyValue("--color-text")).toBe("");
  });

  it("cleans up stale custom props when switching to a built-in theme", () => {
    applyWorkspaceTheme(customTheme());
    expect(root().style.getPropertyValue("--color-bg")).toBe("#101010");
    applyWorkspaceTheme({ mode: "dark", accent: "blue", custom: [] });
    expect(root().style.getPropertyValue("--color-bg")).toBe("");
    expect(root().dataset.theme).toBe("dark");
    expect(root().dataset.accent).toBe("blue");
  });

  it("throws when the selected custom id is not in custom[] (no silent fallback)", () => {
    expect(() =>
      applyWorkspaceTheme({ mode: "ghost", accent: "emerald", custom: [] }),
    ).toThrow();
  });
});
