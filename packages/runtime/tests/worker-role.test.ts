import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workerRole } from "../src/index.ts";

describe("workerRole", () => {
  it("declares a tight CLI allowlist (no spawn/kill/transcript)", () => {
    expect([...workerRole.manifest.allowedCliCommands].sort()).toEqual(
      ["ask", "status", "whoami"].sort(),
    );
  });

  it("ships a non-empty system prompt", () => {
    const text = readFileSync(
      join(workerRole.bundleRoot, workerRole.manifest.systemPromptPath),
      "utf8",
    );
    expect(text.trim().length).toBeGreaterThan(20);
  });

  it("eagerly loads the system prompt content into LoadedRole", () => {
    expect(workerRole.systemPrompt.trim().length).toBeGreaterThan(20);
    expect(workerRole.systemPrompt).toMatch(/orker/);
  });

  it("ships a plugin template directory with .claude-plugin/plugin.json named after the role", () => {
    const pluginRoot = join(workerRole.bundleRoot, workerRole.manifest.pluginTemplatePath);
    const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    const json = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as { name: string };
    expect(json.name).toBe("worker");
  });

  it("ships a SKILL.md per CLI command under skills/<name>/", () => {
    const pluginRoot = join(workerRole.bundleRoot, workerRole.manifest.pluginTemplatePath);
    for (const cmd of workerRole.manifest.allowedCliCommands) {
      expect(existsSync(join(pluginRoot, "skills", cmd, "SKILL.md"))).toBe(true);
    }
  });

  it("ships hooks/hooks.json wrapped in { hooks } and with the __CLOBBER_HOOK_URL__ placeholder", () => {
    const pluginRoot = join(workerRole.bundleRoot, workerRole.manifest.pluginTemplatePath);
    const hooksPath = join(pluginRoot, "hooks", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const raw = readFileSync(hooksPath, "utf8");
    expect(raw).toContain("__CLOBBER_HOOK_URL__");
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks!["SessionStart"]).toBeDefined();
  });

  it("is registered in the role registry as 'worker'", async () => {
    const { loadRoleBundle } = await import("../src/index.ts");
    const loaded = loadRoleBundle("worker");
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.name).toBe("worker");
  });
});
