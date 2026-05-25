import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { managerRole } from "../src/index.ts";

describe("managerRole", () => {
  it("declares wildcard CLI authz so new verbs auto-apply to the manager", () => {
    expect([...managerRole.manifest.allowedCliCommands]).toEqual(["*"]);
  });

  it("defaults to xhigh effort — manager carries the deep-thinking load upstream of workers", () => {
    expect(managerRole.manifest.effort).toBe("xhigh");
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
      "reports",
      "kill",
      "resume",
      "self-skills",
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
    expect(body).toMatch(/clobber spawn worker\b/);
  });

  it("embeds a structural wisdom-log consult into the assignment skill (#178)", () => {
    const pluginRoot = join(managerRole.bundleRoot, managerRole.manifest.pluginTemplatePath);
    const body = readFileSync(join(pluginRoot, "skills", "assignment", "SKILL.md"), "utf8");
    // consume rides assignment by construction — it must reference the wisdom
    // log and the boot context that locates it, generically.
    expect(body).toMatch(/wisdom log/i);
    expect(body).toMatch(/boot context/i);
  });

  it("ships a generic wisdom-capture skill with the observation/mechanic/lesson shape (#178)", () => {
    const pluginRoot = join(managerRole.bundleRoot, managerRole.manifest.pluginTemplatePath);
    const skillPath = join(pluginRoot, "skills", "wisdom-capture", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const body = readFileSync(skillPath, "utf8");
    expect(body).toMatch(/^name:\s*wisdom-capture$/m);
    expect(body).toMatch(/observation/i);
    expect(body).toMatch(/mechanic/i);
    expect(body).toMatch(/lesson/i);
    expect(body).toMatch(/boot context/i);
  });

  it("keeps the engine manager skills free of any workspace-specific log location (#178)", () => {
    const skillsDir = join(
      managerRole.bundleRoot,
      managerRole.manifest.pluginTemplatePath,
      "skills",
    );
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      expect(readFileSync(skillFile, "utf8")).not.toMatch(/tasks#20/);
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
