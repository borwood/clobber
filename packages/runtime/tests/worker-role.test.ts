import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workerRole, defaultSdlcProfile } from "../src/index.ts";

describe("workerRole", () => {
  it("is ephemeral and runs in bypassPermissions for autonomy", () => {
    expect(workerRole.manifest.persistent).toBe(false);
    // permissionMode is inherited from base (#355) — assert the effective value.
    expect(workerRole.manifest.permissionMode).toBeUndefined();
    expect(workerRole.permissionMode).toBe("bypassPermissions");
  });

  it("defaults to high effort — execution still needs depth, but less than the manager's planning", () => {
    expect(workerRole.manifest.effort).toBe("high");
  });

  it("ships the autonomous CLI allowlist (whoami, ask, status, report, reply)", () => {
    expect([...workerRole.manifest.allowedCliCommands].sort()).toEqual(
      ["ask", "reply", "report", "status", "whoami"],
    );
  });

  it("exposes the standard SDLC toolset", () => {
    // allowedTools is inherited from base (#355) — assert the effective value.
    expect(workerRole.manifest.allowedTools).toBeUndefined();
    const tools = new Set(workerRole.allowedTools);
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

  it("the `task` wake-program owns the desk-reading opening move (#212), lifted out of the durable prompt", () => {
    // The "read your desk NOW" protocol is layer C of the `task` opening move,
    // not durable framing — so the same role can be spawned `idle` (waiting).
    const task = workerRole.manifest.wakePrograms?.find((p) => p.name === "task");
    expect(task).toBeDefined();
    expect(task!.system).toMatch(/CLOBBER_DESK_DIR/);
    expect(task!.system).toMatch(/boot-tasks\.json/);
    expect(task!.system).toMatch(/assignment\.md/);
    expect(task!.user).not.toBeNull();
    // The durable system prompt no longer carries the desk protocol.
    expect(workerRole.systemPrompt).not.toMatch(/CLOBBER_DESK_DIR/);
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

  it("inherits the hooks mechanism from base (#355) — no own copy on disk", () => {
    const pluginRoot = join(
      workerRole.bundleRoot,
      workerRole.manifest.pluginTemplatePath,
    );
    // The fork no longer ships its own hooks file; it inherits base's.
    expect(existsSync(join(pluginRoot, "hooks", "hooks.json"))).toBe(false);
    const raw = workerRole.hooksJson;
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

  it("ships a worktree-jail habit in the self.tool-use path", () => {
    const jail = workerRole.habits.find((h) => h.name === "worktree-jail");
    expect(jail).toBeDefined();
    expect(jail?.path).toBe("self.tool-use");
    expect(jail?.action.kind).toBe("refuse");
  });
});
