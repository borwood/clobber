import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { managerRole } from "../src/index.ts";

describe("managerRole", () => {
  it("declares the CLI commands the manager needs (including observability triple)", () => {
    expect([...managerRole.manifest.allowedCliCommands].sort()).toEqual(
      ["agents", "ask", "kill", "spawn", "status", "transcript", "whoami"].sort(),
    );
  });

  it("ships a non-empty system prompt", () => {
    const text = readFileSync(
      join(managerRole.bundleRoot, managerRole.manifest.systemPromptPath),
      "utf8",
    );
    expect(text.trim().length).toBeGreaterThan(20);
  });

  it("eagerly loads the system prompt content into LoadedRole", () => {
    expect(managerRole.systemPrompt.trim().length).toBeGreaterThan(20);
    expect(managerRole.systemPrompt).toMatch(/Manager/);
  });

  it("ships a plugin template directory with .claude-plugin/plugin.json named after the role", () => {
    const pluginRoot = join(managerRole.bundleRoot, managerRole.manifest.pluginTemplatePath);
    const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    const json = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as { name: string };
    expect(json.name).toBe("manager");
  });

  it("ships a SKILL.md per CLI command under skills/<name>/", () => {
    const pluginRoot = join(managerRole.bundleRoot, managerRole.manifest.pluginTemplatePath);
    for (const cmd of managerRole.manifest.allowedCliCommands) {
      expect(existsSync(join(pluginRoot, "skills", cmd, "SKILL.md"))).toBe(true);
    }
  });

  it("ships hooks/hooks.json wrapped in { hooks } and with the __CLOBBER_HOOK_URL__ placeholder", () => {
    const pluginRoot = join(managerRole.bundleRoot, managerRole.manifest.pluginTemplatePath);
    const hooksPath = join(pluginRoot, "hooks", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const raw = readFileSync(hooksPath, "utf8");
    expect(raw).toContain("__CLOBBER_HOOK_URL__");
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks!["SessionStart"]).toBeDefined();
  });
});
