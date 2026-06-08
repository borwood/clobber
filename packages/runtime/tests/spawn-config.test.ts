import { readFileSync } from "node:fs";
import { describe, it, expect } from "bun:test";
import { buildHookSettings, buildClaudeArgs, ALL_HOOK_EVENTS } from "../src/spawn-config.ts";

describe("buildHookSettings", () => {
  it("registers an HTTP hook for every event with the given url", () => {
    const settings = buildHookSettings({ url: "http://127.0.0.1:3300/hook" });

    for (const event of ALL_HOOK_EVENTS) {
      const handlers = settings.hooks[event];
      expect(handlers).toBeDefined();
      expect(handlers!.length).toBe(1);
      const inner = handlers![0]!.hooks[0]!;
      expect(inner.type).toBe("http");
      expect(inner.url).toBe("http://127.0.0.1:3300/hook");
    }
  });

  it("defaults async=false (so hooks block claude until we respond)", () => {
    const settings = buildHookSettings({ url: "http://x/hook" });
    const inner = settings.hooks.PreToolUse![0]!.hooks[0]!;
    expect(inner.async).toBe(false);
  });

  it("respects async override", () => {
    const settings = buildHookSettings({ url: "http://x/hook", async: true });
    const inner = settings.hooks.PreToolUse![0]!.hooks[0]!;
    expect(inner.async).toBe(true);
  });

  it("attaches matchers on Pre/PostToolUse so they fire on every tool", () => {
    const settings = buildHookSettings({ url: "http://x/hook" });
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe(".*");
    expect(settings.hooks.PostToolUse![0]!.matcher).toBe(".*");
    expect(settings.hooks.SessionStart![0]!.matcher).toBeUndefined();
  });
});

describe("buildClaudeArgs", () => {
  const baseSettings = buildHookSettings({ url: "http://x/hook" });

  it("emits long-running stream-json mode (no prompt arg — initial prompt streams via stdin)", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc-123",
      settings: baseSettings,
    });

    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc-123");

    // settings delivered as a file path, not an inline JSON string
    expect(args).toContain("--settings");
    const settingsPath = args[args.indexOf("--settings") + 1]!;
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(baseSettings);

    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--include-hook-events");
    expect(args).toContain("--verbose");

    cleanup();
  });

  it("omits --setting-sources when settingSources is not provided (claude defaults apply)", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
    });
    expect(args).not.toContain("--setting-sources");
    cleanup();
  });

  it("emits --setting-sources as a comma-joined list when settingSources is provided", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      settingSources: ["user", "project", "local"],
    });
    expect(args).toContain("--setting-sources");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user,project,local");
    cleanup();
  });

  it("omits --setting-sources when settingSources is an empty array", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      settingSources: [],
    });
    expect(args).not.toContain("--setting-sources");
    cleanup();
  });

  it("forwards permission-mode and allowedTools when supplied", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
    });

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");

    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Bash,Read");

    cleanup();
  });

  it("omits --permission-mode and --allowedTools when not supplied", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
    });
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
    cleanup();
  });

  it("omits --settings when settings is not supplied", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--settings");
    cleanup();
  });

  it("emits one --plugin-dir per entry in pluginDirs (in order)", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      pluginDirs: ["/tmp/.clobber/roles/manager", "/tmp/.clobber/roles/worker"],
    });
    const flags = args
      .map((a, i) => (a === "--plugin-dir" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);
    expect(flags).toEqual([
      "/tmp/.clobber/roles/manager",
      "/tmp/.clobber/roles/worker",
    ]);
    cleanup();
  });

  it("does not require --settings when --plugin-dir provides hooks", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      pluginDirs: ["/tmp/.clobber/roles/manager"],
    });
    expect(args).not.toContain("--settings");
    expect(args).toContain("--plugin-dir");
    cleanup();
  });

  // AC1 pin: --append-system-prompt-file (not inline) for all prompt sizes.
  // Pre-fix: args had inline --append-system-prompt ≥131072 bytes → E2BIG on spawn.
  // Post-fix: always file delivery regardless of size.
  it("emits --append-system-prompt-file with path to file holding the prompt text", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      appendSystemPrompt: "You are the Manager.",
    });
    expect(args).toContain("--append-system-prompt-file");
    expect(args).not.toContain("--append-system-prompt");
    const promptPath = args[args.indexOf("--append-system-prompt-file") + 1]!;
    expect(readFileSync(promptPath, "utf8")).toBe("You are the Manager.");
    cleanup();
  });

  // AC1 repro+pin: large prompt (>MAX_ARG_STRLEN=131072) must NOT appear inline.
  // The cycle path composes a full role charter + CYCLE_ORIENTATION_LAYER that
  // historically exceeded 131072 bytes and caused E2BIG. The file arg itself is
  // always a short path, well under the limit.
  it("delivers oversized appendSystemPrompt (>131072 bytes) via file, keeping the arg itself short", () => {
    const bigPrompt = "x".repeat(133000); // 133000 > MAX_ARG_STRLEN=131072
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "cycle-session",
      appendSystemPrompt: bigPrompt,
    });
    expect(args).toContain("--append-system-prompt-file");
    expect(args).not.toContain("--append-system-prompt");
    const promptPath = args[args.indexOf("--append-system-prompt-file") + 1]!;
    expect(readFileSync(promptPath, "utf8")).toBe(bigPrompt);
    // The arg value is a file path — far shorter than MAX_ARG_STRLEN.
    expect(Buffer.byteLength(promptPath)).toBeLessThan(131072);
    cleanup();
  });

  it("omits --append-system-prompt-file when appendSystemPrompt is not supplied", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("--append-system-prompt");
    cleanup();
  });

  it("passes --name when displayName is provided (sets claude's session label)", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc", displayName: "deploy-fix" });
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("deploy-fix");
    cleanup();
  });

  it("omits --name when displayName is not provided", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--name");
    cleanup();
  });

  it("omits --name when displayName is the empty string", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc", displayName: "" });
    expect(args).not.toContain("--name");
    cleanup();
  });

  it("emits --effort <level> when effort is supplied", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc", effort: "high" });
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    cleanup();
  });

  it("omits --effort when effort is not supplied", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--effort");
    cleanup();
  });

  it("emits --model <value> when model is supplied", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc", model: "sonnet" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    cleanup();
  });

  it("omits --model when model is not supplied (backward-compat: byte-identical to today)", () => {
    const { args, cleanup } = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--model");
    cleanup();
  });

  // AC4 non-leak: settings file is not world-readable (mode 0o600).
  it("writes settings file with restricted permissions (not world-readable)", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
    });
    const settingsPath = args[args.indexOf("--settings") + 1]!;
    const { mode } = require("node:fs").statSync(settingsPath);
    // mode & 0o777 extracts the permission bits; 0o600 = owner rw only
    expect(mode & 0o777).toBe(0o600);
    cleanup();
  });

  // AC4 non-leak: prompt file is not world-readable (mode 0o600).
  it("writes appendSystemPrompt file with restricted permissions (not world-readable)", () => {
    const { args, cleanup } = buildClaudeArgs({
      sessionId: "abc",
      appendSystemPrompt: "top secret prompt",
    });
    const promptPath = args[args.indexOf("--append-system-prompt-file") + 1]!;
    const { mode } = require("node:fs").statSync(promptPath);
    expect(mode & 0o777).toBe(0o600);
    cleanup();
  });
});
