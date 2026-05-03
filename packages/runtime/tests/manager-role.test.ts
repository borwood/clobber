import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { managerRole } from "../src/index.ts";

describe("managerRole", () => {
  it("declares the four CLI commands the manager needs", () => {
    expect([...managerRole.manifest.allowedCliCommands].sort()).toEqual(
      ["ask", "spawn", "status", "whoami"].sort(),
    );
  });

  it("ships a non-empty system prompt", () => {
    const text = readFileSync(
      join(managerRole.bundleRoot, managerRole.manifest.systemPromptPath),
      "utf8",
    );
    expect(text.trim().length).toBeGreaterThan(20);
  });

  it("ships one skill markdown per CLI command", () => {
    const skillNames = managerRole.manifest.skills.map((s) => s.name).sort();
    expect(skillNames).toEqual(["ask", "spawn", "status", "whoami"]);
    for (const skill of managerRole.manifest.skills) {
      expect(existsSync(join(managerRole.bundleRoot, skill.path))).toBe(true);
    }
  });

  it("ships a settings overlay that registers HTTP hooks via __CLOBBER_HOOK_URL__ placeholder", () => {
    const raw = readFileSync(
      join(managerRole.bundleRoot, managerRole.manifest.settingsOverlayPath),
      "utf8",
    );
    expect(raw).toContain("__CLOBBER_HOOK_URL__");
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    expect(parsed.hooks).toBeDefined();
  });
});
