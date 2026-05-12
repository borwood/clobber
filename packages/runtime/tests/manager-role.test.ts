import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { managerRole } from "../src/index.ts";

describe("managerRole", () => {
  it("declares wildcard CLI authz so new verbs auto-apply to the manager", () => {
    expect([...managerRole.manifest.allowedCliCommands]).toEqual(["*"]);
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

  it("ships SKILL.md for every CLI verb the manager actually drives", () => {
    const pluginRoot = join(managerRole.bundleRoot, managerRole.manifest.pluginTemplatePath);
    const verbsTrainedByBundle = [
      "whoami",
      "spawn",
      "ask",
      "status",
      "agents",
      "transcript",
      "kill",
    ];
    for (const cmd of verbsTrainedByBundle) {
      expect(existsSync(join(pluginRoot, "skills", cmd, "SKILL.md"))).toBe(true);
    }
  });

  it("ships an assignment skill that drives /assignment dispatch (#90)", () => {
    const pluginRoot = join(managerRole.bundleRoot, managerRole.manifest.pluginTemplatePath);
    const skillPath = join(pluginRoot, "skills", "assignment", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const body = readFileSync(skillPath, "utf8");
    expect(body).toMatch(/seed-todos\.json/);
    expect(body).toMatch(/--briefing-dir/);
    expect(body).toMatch(/worker-bee/);
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
