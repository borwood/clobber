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
    const args = buildClaudeArgs({
      sessionId: "abc-123",
      settings: baseSettings,
    });

    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc-123");

    expect(args).toContain("--settings");
    const settingsArg = args[args.indexOf("--settings") + 1]!;
    expect(JSON.parse(settingsArg)).toEqual(baseSettings);

    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--include-hook-events");
    expect(args).toContain("--verbose");
  });

  it("omits --setting-sources when settingSources is not provided (claude defaults apply)", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
    });
    expect(args).not.toContain("--setting-sources");
  });

  it("emits --setting-sources as a comma-joined list when settingSources is provided", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      settingSources: ["user", "project", "local"],
    });
    expect(args).toContain("--setting-sources");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user,project,local");
  });

  it("omits --setting-sources when settingSources is an empty array", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
      settingSources: [],
    });
    expect(args).not.toContain("--setting-sources");
  });

  it("forwards permission-mode and allowedTools when supplied", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      settings: baseSettings,
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
    });
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
  });

  it("omits --settings when settings is not supplied", () => {
    const args = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--settings");
  });

  it("emits one --plugin-dir per entry in pluginDirs (in order)", () => {
    const args = buildClaudeArgs({
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
  });

  it("does not require --settings when --plugin-dir provides hooks", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      pluginDirs: ["/tmp/.clobber/roles/manager"],
    });
    expect(args).not.toContain("--settings");
    expect(args).toContain("--plugin-dir");
  });

  it("emits --append-system-prompt with the supplied text", () => {
    const args = buildClaudeArgs({
      sessionId: "abc",
      appendSystemPrompt: "You are the Manager.",
    });
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      "You are the Manager.",
    );
  });

  it("omits --append-system-prompt when not supplied", () => {
    const args = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--append-system-prompt");
  });

  it("passes --name when displayName is provided (sets claude's session label)", () => {
    const args = buildClaudeArgs({ sessionId: "abc", displayName: "deploy-fix" });
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("deploy-fix");
  });

  it("omits --name when displayName is not provided", () => {
    const args = buildClaudeArgs({ sessionId: "abc" });
    expect(args).not.toContain("--name");
  });

  it("omits --name when displayName is the empty string", () => {
    const args = buildClaudeArgs({ sessionId: "abc", displayName: "" });
    expect(args).not.toContain("--name");
  });
});
