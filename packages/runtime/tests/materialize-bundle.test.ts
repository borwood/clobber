import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeBundle, type RoleBundleData } from "../src/index.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-mat-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

const HOOKS_TEMPLATE = JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: "http", url: "__CLOBBER_HOOK_URL__", async: false }] },
    ],
  },
});

const sampleBundle: RoleBundleData = {
  pluginName: "manager",
  description: "Permanent inhabitant of a workspace.",
  framing: "You are the **Manager**.",
  systemPrompt: "You are the manager.",
  allowedTools: [],
  skills: [
    { name: "whoami", body: "# whoami\n\nRun `clobber whoami`." },
    { name: "spawn", body: "# spawn\n\nUse to start workers." },
    { name: "ask", body: "# ask\n\nAsk the user." },
    { name: "status", body: "# status\n\nReport status." },
  ],
  promptModuleRefs: [],
  wakePrograms: [],
  hooksJson: HOOKS_TEMPLATE,
  habits: [],
};

describe("materializeBundle", () => {
  it("writes the role plugin tree under <repo>/.clobber/roles/<role>/", () => {
    const result = materializeBundle({
      bundle: sampleBundle,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });

    expect(result.pluginDir).toBe(join(repoPath, ".clobber", "roles", "manager"));
    expect(existsSync(join(result.pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(result.pluginDir, "skills", "whoami", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.pluginDir, "skills", "spawn", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.pluginDir, "skills", "ask", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.pluginDir, "skills", "status", "SKILL.md"))).toBe(true);

    const whoami = readFileSync(join(result.pluginDir, "skills", "whoami", "SKILL.md"), "utf8");
    expect(whoami).toContain("clobber whoami");
  });

  it("plugin.json carries the bundle's pluginName so forks materialize under their own name", () => {
    const result = materializeBundle({
      bundle: { ...sampleBundle, pluginName: "auditor" },
      repoPath,
      hookUrl: "http://x/hook",
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });

    expect(result.pluginDir).toBe(join(repoPath, ".clobber", "roles", "auditor"));
    const manifest = JSON.parse(
      readFileSync(join(result.pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("auditor");
  });

  it("never writes anything under <repo>/.claude/", () => {
    materializeBundle({
      bundle: sampleBundle,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });
    expect(existsSync(join(repoPath, ".claude"))).toBe(false);
  });

  it("substitutes __CLOBBER_HOOK_URL__ in the materialized hooks/hooks.json", () => {
    const result = materializeBundle({
      bundle: sampleBundle,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });

    const hooksPath = join(result.pluginDir, "hooks", "hooks.json");
    const raw = readFileSync(hooksPath, "utf8");
    expect(raw).not.toContain("__CLOBBER_HOOK_URL__");
    expect(raw).toContain("http://127.0.0.1:3300/hook");
    const parsed = JSON.parse(raw) as { hooks: Record<string, unknown> };
    expect(parsed.hooks["SessionStart"]).toBeDefined();
  });

  it("creates a per-bundle bin dir with an executable `clobber` shim that points at the cli entry", () => {
    const result = materializeBundle({
      bundle: sampleBundle,
      repoPath,
      hookUrl: "http://x/hook",
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });

    const shim = join(result.binDir, "clobber");
    expect(existsSync(shim)).toBe(true);
    const stat = statSync(shim);
    expect((stat.mode & 0o111) !== 0).toBe(true);
    const contents = readFileSync(shim, "utf8");
    expect(contents).toContain("/abs/cli/index.ts");
  });

  it("is idempotent — running twice does not throw and leaves files in place", () => {
    materializeBundle({
      bundle: sampleBundle,
      repoPath,
      hookUrl: "http://x/hook",
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });
    materializeBundle({
      bundle: sampleBundle,
      repoPath,
      hookUrl: "http://x/hook",
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });
    expect(
      existsSync(join(repoPath, ".clobber", "roles", "manager", "skills", "whoami", "SKILL.md")),
    ).toBe(true);
  });
});

// #450 — companion files alongside SKILL.md must be materialized to the runtime
// plugin dir so agents can read them during a session.
describe("materializeBundle — companion files (#450)", () => {
  it("writes companion files alongside SKILL.md under skills/<name>/", () => {
    const bundle: RoleBundleData = {
      pluginName: "test-role",
      framing: "",
      systemPrompt: "prompt",
      allowedTools: [],
      skills: [
        {
          name: "my-skill",
          body: "# MY SKILL",
          files: { "context.md": "companion content", "runbook.md": "runbook content" },
        },
      ],
      promptModuleRefs: [],
      wakePrograms: [],
      hooksJson: "{}",
      habits: [],
    };
    const result = materializeBundle({
      bundle,
      repoPath,
      hookUrl: "http://test.invalid/hook",
      cliEntry: "/dummy/cli.ts",
      inSessionHabits: false,
    });

    const skillDir = join(result.pluginDir, "skills", "my-skill");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "context.md"))).toBe(true);
    expect(readFileSync(join(skillDir, "context.md"), "utf8")).toBe("companion content");
    expect(existsSync(join(skillDir, "runbook.md"))).toBe(true);
    expect(readFileSync(join(skillDir, "runbook.md"), "utf8")).toBe("runbook content");
  });

  it("a skill with no companion files still materializes correctly (files absent or empty)", () => {
    const bundle: RoleBundleData = {
      ...({
        pluginName: "test-role",
        framing: "",
        systemPrompt: "prompt",
        allowedTools: [],
        skills: [{ name: "plain-skill", body: "plain body" }],
        promptModuleRefs: [],
        wakePrograms: [],
        hooksJson: "{}",
        habits: [],
      } as RoleBundleData),
    };
    const result = materializeBundle({
      bundle,
      repoPath,
      hookUrl: "http://test.invalid/hook",
      cliEntry: "/dummy/cli.ts",
      inSessionHabits: false,
    });
    expect(existsSync(join(result.pluginDir, "skills", "plain-skill", "SKILL.md"))).toBe(true);
  });
});
