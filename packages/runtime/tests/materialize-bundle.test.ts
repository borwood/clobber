import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managerRole, materializeBundle } from "../src/index.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-mat-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

describe("materializeBundle", () => {
  it("writes the role plugin tree under <repo>/.clobber/roles/<role>/", () => {
    const result = materializeBundle({
      bundle: managerRole,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
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

  it("never writes anything under <repo>/.claude/", () => {
    materializeBundle({
      bundle: managerRole,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
    });
    expect(existsSync(join(repoPath, ".claude"))).toBe(false);
  });

  it("substitutes __CLOBBER_HOOK_URL__ in the materialized hooks/hooks.json", () => {
    const result = materializeBundle({
      bundle: managerRole,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
    });

    const hooksPath = join(result.pluginDir, "hooks", "hooks.json");
    const raw = readFileSync(hooksPath, "utf8");
    expect(raw).not.toContain("__CLOBBER_HOOK_URL__");
    expect(raw).toContain("http://127.0.0.1:3300/hook");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["SessionStart"]).toBeDefined();
  });

  it("creates a per-bundle bin dir with an executable `clobber` shim that points at the cli entry", () => {
    const result = materializeBundle({
      bundle: managerRole,
      repoPath,
      hookUrl: "http://x/hook",
      cliEntry: "/abs/cli/index.ts",
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
      bundle: managerRole,
      repoPath,
      hookUrl: "http://x/hook",
      cliEntry: "/abs/cli/index.ts",
    });
    materializeBundle({
      bundle: managerRole,
      repoPath,
      hookUrl: "http://x/hook",
      cliEntry: "/abs/cli/index.ts",
    });
    expect(
      existsSync(join(repoPath, ".clobber", "roles", "manager", "skills", "whoami", "SKILL.md")),
    ).toBe(true);
  });
});
