import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workerBeeRole } from "../src/index.ts";

const SDLC_PHASES = [
  "research",
  "failing-test",
  "implement",
  "open-pr",
  "watch-ci",
] as const;

describe("workerBeeRole", () => {
  it("is ephemeral and runs in bypassPermissions for autonomy", () => {
    expect(workerBeeRole.manifest.persistent).toBe(false);
    expect(workerBeeRole.manifest.permissionMode).toBe("bypassPermissions");
  });

  it("inherits the worker CLI baseline (whoami, ask, status)", () => {
    const cmds = new Set(workerBeeRole.manifest.allowedCliCommands);
    expect(cmds.has("whoami")).toBe(true);
    expect(cmds.has("ask")).toBe(true);
    expect(cmds.has("status")).toBe(true);
  });

  it("exposes the standard SDLC toolset", () => {
    const tools = new Set(workerBeeRole.manifest.allowedTools ?? []);
    for (const t of ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]) {
      expect(tools.has(t)).toBe(true);
    }
  });

  it("ships a non-empty system prompt that frames the issue-driven SDLC walk", () => {
    expect(workerBeeRole.systemPrompt.trim().length).toBeGreaterThan(40);
    expect(workerBeeRole.systemPrompt).toMatch(/issue/i);
    expect(workerBeeRole.systemPrompt).toMatch(/final report/i);
  });

  it("first-action prompt points at the desk briefing packet (#90)", () => {
    expect(workerBeeRole.systemPrompt).toMatch(/CLOBBER_DESK_DIR/);
    expect(workerBeeRole.systemPrompt).toMatch(/seed-todos\.json/);
    expect(workerBeeRole.systemPrompt).toMatch(/assignment\.md/);
  });

  it("ships a plugin template with .claude-plugin/plugin.json named 'worker-bee'", () => {
    const pluginRoot = join(
      workerBeeRole.bundleRoot,
      workerBeeRole.manifest.pluginTemplatePath,
    );
    const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    const json = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
      name: string;
    };
    expect(json.name).toBe("worker-bee");
  });

  it("ships a SKILL.md per CLI command", () => {
    const pluginRoot = join(
      workerBeeRole.bundleRoot,
      workerBeeRole.manifest.pluginTemplatePath,
    );
    for (const cmd of workerBeeRole.manifest.allowedCliCommands) {
      expect(existsSync(join(pluginRoot, "skills", cmd, "SKILL.md"))).toBe(true);
    }
  });

  it("ships a SKILL.md for each SDLC phase", () => {
    const pluginRoot = join(
      workerBeeRole.bundleRoot,
      workerBeeRole.manifest.pluginTemplatePath,
    );
    for (const phase of SDLC_PHASES) {
      expect(existsSync(join(pluginRoot, "skills", phase, "SKILL.md"))).toBe(
        true,
      );
    }
  });

  it("ships hooks/hooks.json with the __CLOBBER_HOOK_URL__ placeholder", () => {
    const pluginRoot = join(
      workerBeeRole.bundleRoot,
      workerBeeRole.manifest.pluginTemplatePath,
    );
    const hooksPath = join(pluginRoot, "hooks", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const raw = readFileSync(hooksPath, "utf8");
    expect(raw).toContain("__CLOBBER_HOOK_URL__");
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks!["SessionStart"]).toBeDefined();
  });

  it("is registered in the role registry as 'worker-bee'", async () => {
    const { loadRoleBundle } = await import("../src/index.ts");
    const loaded = loadRoleBundle("worker-bee");
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.name).toBe("worker-bee");
  });
});
