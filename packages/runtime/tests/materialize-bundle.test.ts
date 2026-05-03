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
  it("writes role skills into <repo>/.claude/skills/<role>/", () => {
    materializeBundle({
      bundle: managerRole,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
    });

    const skillsDir = join(repoPath, ".claude", "skills", "manager");
    expect(existsSync(join(skillsDir, "whoami.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "spawn.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "ask.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "status.md"))).toBe(true);

    const whoami = readFileSync(join(skillsDir, "whoami.md"), "utf8");
    expect(whoami).toContain("clobber whoami");
  });

  it("returns settings JSON with __CLOBBER_HOOK_URL__ substituted by the real hook url", () => {
    const result = materializeBundle({
      bundle: managerRole,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli/index.ts",
    });

    const settings = result.settings as { hooks: Record<string, unknown> };
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain("__CLOBBER_HOOK_URL__");
    expect(serialized).toContain("http://127.0.0.1:3300/hook");
    expect(settings.hooks).toBeDefined();
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
      existsSync(join(repoPath, ".claude", "skills", "manager", "whoami.md")),
    ).toBe(true);
  });
});
