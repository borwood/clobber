import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workerRole, defaultSdlcProfile } from "../src/index.ts";

describe("workerRole (collapsed worker + worker-bee)", () => {
  it("is ephemeral and runs in bypassPermissions for autonomy", () => {
    expect(workerRole.manifest.persistent).toBe(false);
    expect(workerRole.manifest.permissionMode).toBe("bypassPermissions");
  });

  it("ships the autonomous CLI allowlist (whoami, ask, status, report)", () => {
    expect([...workerRole.manifest.allowedCliCommands].sort()).toEqual(
      ["ask", "report", "status", "whoami"],
    );
  });

  it("exposes the standard SDLC toolset", () => {
    const tools = new Set(workerRole.manifest.allowedTools ?? []);
    for (const t of ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]) {
      expect(tools.has(t)).toBe(true);
    }
  });

  it("declares the default 5-phase SDLC profile on its manifest", () => {
    expect(workerRole.manifest.sdlc).toEqual(defaultSdlcProfile);
  });

  it("ships a non-empty system prompt that frames the issue-driven SDLC walk", () => {
    expect(workerRole.systemPrompt.trim().length).toBeGreaterThan(40);
    expect(workerRole.systemPrompt).toMatch(/issue/i);
    expect(workerRole.systemPrompt).toMatch(/final report/i);
  });

  it("first-action prompt points at the desk briefing packet (#90)", () => {
    expect(workerRole.systemPrompt).toMatch(/CLOBBER_DESK_DIR/);
    expect(workerRole.systemPrompt).toMatch(/seed-todos\.json/);
    expect(workerRole.systemPrompt).toMatch(/assignment\.md/);
  });

  it("ships a plugin template with .claude-plugin/plugin.json named 'worker'", () => {
    const pluginRoot = join(
      workerRole.bundleRoot,
      workerRole.manifest.pluginTemplatePath,
    );
    const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    const json = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
      name: string;
    };
    expect(json.name).toBe("worker");
  });

  it("ships a SKILL.md per CLI command", () => {
    const pluginRoot = join(
      workerRole.bundleRoot,
      workerRole.manifest.pluginTemplatePath,
    );
    for (const cmd of workerRole.manifest.allowedCliCommands) {
      expect(existsSync(join(pluginRoot, "skills", cmd, "SKILL.md"))).toBe(true);
    }
  });

  it("ships a SKILL.md for each default-profile SDLC phase", () => {
    const pluginRoot = join(
      workerRole.bundleRoot,
      workerRole.manifest.pluginTemplatePath,
    );
    for (const phase of defaultSdlcProfile.phases) {
      expect(existsSync(join(pluginRoot, "skills", phase.id, "SKILL.md"))).toBe(
        true,
      );
    }
  });

  it("ships hooks/hooks.json with the __CLOBBER_HOOK_URL__ placeholder", () => {
    const pluginRoot = join(
      workerRole.bundleRoot,
      workerRole.manifest.pluginTemplatePath,
    );
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
