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

  it("includes session id, settings JSON, prompt, and stream-json output", () => {
    const args = buildClaudeArgs({
      sessionId: "abc-123",
      settings: baseSettings,
      prompt: "hello world",
    });

    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc-123");

    expect(args).toContain("--settings");
    const settingsArg = args[args.indexOf("--settings") + 1]!;
    expect(JSON.parse(settingsArg)).toEqual(baseSettings);

    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--include-hook-events");

    expect(args[args.length - 1]).toBe("hello world");
  });

  it("isolates from user-level claude config via --setting-sources user", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      prompt: "p",
    });
    expect(args).toContain("--setting-sources");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
  });

  it("forwards permission-mode and allowedTools when supplied", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      prompt: "p",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
    });

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");

    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Bash,Read");
  });

  it("omits --permission-mode and --allowedTools when not supplied", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      prompt: "p",
    });
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
  });
});
