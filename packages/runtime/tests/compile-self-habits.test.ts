import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HabitSchema, type Habit } from "@clobber/shared";
import { compileSelfHabits, materializeBundle, type RoleBundleData } from "../src/index.ts";

const BASE_HOOKS_PATH = join(
  import.meta.dir,
  "../roles/base/plugin-template/hooks/hooks.json",
);
const HOOK_URL = "http://127.0.0.1:3300/hook";

function habit(partial: Record<string, unknown>): Habit {
  return HabitSchema.parse(partial);
}

const bundleWith = (habits: readonly Habit[]): RoleBundleData => ({
  pluginName: "fixture",
  framing: "f",
  systemPrompt: "s",
  allowedTools: [],
  skills: [],
  promptModuleRefs: [],
  wakePrograms: [],
  hooksJson: readFileSync(BASE_HOOKS_PATH, "utf8"),
  habits,
});

let repoPath: string;
beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-habit-compile-"));
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function materializedHooks(bundle: RoleBundleData, inSessionHabits: boolean): string {
  const result = materializeBundle({
    bundle,
    repoPath,
    hookUrl: HOOK_URL,
    cliEntry: "/abs/cli/index.ts",
    inSessionHabits,
  });
  return readFileSync(join(result.pluginDir, "hooks", "hooks.json"), "utf8");
}

describe("compileSelfHabits", () => {
  it("compiles a self.tool-use habit to a handler whose native matcher carries `match`", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.tool-use", name: "bash-note", match: "Bash", action: { kind: "inject", hint: "h" } })],
      HOOK_URL,
    );
    expect(compiled.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "http", url: HOOK_URL, async: false }] },
    ]);
    expect(compiled.PostToolUse).toBeUndefined();
  });

  it("phase:post routes the handler to PostToolUse", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.tool-use", phase: "post", name: "n", action: { kind: "inject", hint: "h" } })],
      HOOK_URL,
    );
    expect(compiled.PostToolUse).toHaveLength(1);
    expect(compiled.PreToolUse).toBeUndefined();
  });

  it("a match-less self.tool-use habit registers the `.*` matcher (any tool)", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.tool-use", name: "n", action: { kind: "inject", hint: "h" } })],
      HOOK_URL,
    );
    expect(compiled.PreToolUse?.[0]?.matcher).toBe(".*");
  });

  // AC4: match_path-only / match_command-only habits compile to ".*" native matcher.
  // The narrowing happens receiver-side; compile side is already correct.
  it("a match_path-only habit compiles to the '.*' native matcher", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.tool-use", name: "docs-freshness", match_path: "cli-capabilities\\.ts$", action: { kind: "inject", hint: "run docs:gen" } })],
      HOOK_URL,
    );
    expect(compiled.PreToolUse?.[0]?.matcher).toBe(".*");
    expect(compiled.PostToolUse).toBeUndefined();
  });

  it("a match_command-only habit compiles to the '.*' native matcher", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.tool-use", name: "test-hygiene", match_command: "\\bbun test\\b", action: { kind: "inject", hint: "unset CLOBBER_*" } })],
      HOOK_URL,
    );
    expect(compiled.PreToolUse?.[0]?.matcher).toBe(".*");
  });

  it("a non-tool self path (self.session-message) registers a matcher-LESS handler", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.session-message", name: "n", match: "deploy", action: { kind: "inject", hint: "h" } })],
      HOOK_URL,
    );
    expect(compiled.UserPromptSubmit).toEqual([
      { hooks: [{ type: "http", url: HOOK_URL, async: false }] },
    ]);
  });

  it("a refuse habit on self.tool-use compiles to the SAME PreToolUse handler as inject", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.tool-use", name: "jail", match: "Edit|Write", action: { kind: "refuse", predicate: { outside: "/repo" }, reason: "jailed" } })],
      HOOK_URL,
    );
    expect(compiled.PreToolUse).toEqual([
      { matcher: "Edit|Write", hooks: [{ type: "http", url: HOOK_URL, async: false }] },
    ]);
    expect(compiled.PostToolUse).toBeUndefined();
  });

  it("does NOT compile the [S]/[V*] paths or disabled habits", () => {
    const compiled = compileSelfHabits(
      [
        habit({ path: "self.session-age", name: "a", after_ms: 1000, action: { kind: "inject", hint: "h" } }),
        habit({ path: "self.desk-change", name: "d", glob: "*.md", action: { kind: "inject", hint: "h" } }),
        habit({ path: "self.tool-use", name: "off", enabled: false, action: { kind: "inject", hint: "h" } }),
      ],
      HOOK_URL,
    );
    expect(Object.keys(compiled)).toHaveLength(0);
  });

  // AC6 — compile continuity: session-length registers exactly two matcher-less
  // handlers (PostToolUse + UserPromptSubmit); zero-habit output byte-identical.
  it("AC6: self.session-length registers matcher-less handlers on PostToolUse AND UserPromptSubmit", () => {
    const compiled = compileSelfHabits(
      [habit({ path: "self.session-length", name: "guard", max_tokens: 100_000, action: { kind: "inject", hint: "h" } })],
      HOOK_URL,
    );
    expect(compiled.PostToolUse).toHaveLength(1);
    expect(compiled.PostToolUse?.[0]).toEqual({ hooks: [{ type: "http", url: HOOK_URL, async: false }] });
    expect(compiled.UserPromptSubmit).toHaveLength(1);
    expect(compiled.UserPromptSubmit?.[0]).toEqual({ hooks: [{ type: "http", url: HOOK_URL, async: false }] });
    expect(compiled.PreToolUse).toBeUndefined();
    expect(compiled.Stop).toBeUndefined();
  });

  it("AC6: zero-habit compile produces empty output (continuity: session-length adds nothing when absent)", () => {
    const compiled = compileSelfHabits([], HOOK_URL);
    expect(Object.keys(compiled)).toHaveLength(0);
  });
});

describe("materializeBundle — habit compile (the continuity gate)", () => {
  it("byte-identical: an UNMODIFIED role (no self habits) materializes today's hooks.json verbatim", () => {
    const expected = readFileSync(BASE_HOOKS_PATH, "utf8").split("__CLOBBER_HOOK_URL__").join(HOOK_URL);
    const actual = materializedHooks(bundleWith([]), true);
    expect(actual).toBe(expected);
  });

  it("byte-identical: a codex (inSessionHabits:false) spawn never compiles, even with a self habit", () => {
    const expected = readFileSync(BASE_HOOKS_PATH, "utf8").split("__CLOBBER_HOOK_URL__").join(HOOK_URL);
    const withHabit = bundleWith([
      habit({ path: "self.tool-use", name: "n", match: "Bash", action: { kind: "inject", hint: "h" } }),
    ]);
    expect(materializedHooks(withHabit, false)).toBe(expected);
  });

  it("a self.tool-use habit adds its handler ON TOP of the intact 8-event baseline", () => {
    const withHabit = bundleWith([
      habit({ path: "self.tool-use", name: "n", match: "Bash", action: { kind: "inject", hint: "h" } }),
    ]);
    const parsed = JSON.parse(materializedHooks(withHabit, true)) as {
      hooks: Record<string, { matcher?: string }[]>;
    };
    // All 8 baseline events still instrumented — baseline IPC intact.
    for (const event of [
      "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
      "PostToolUse", "Notification", "Stop", "PreCompact",
    ]) {
      expect(parsed.hooks[event]).toBeDefined();
    }
    // The baseline ".*" PreToolUse handler PLUS the habit's "Bash" matcher.
    const matchers = parsed.hooks["PreToolUse"]!.map((h) => h.matcher);
    expect(matchers).toContain(".*");
    expect(matchers).toContain("Bash");
  });
});
