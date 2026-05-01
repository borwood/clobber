import { describe, it, expect } from "bun:test";
import { HookPayloadSchema } from "../src/hooks/payloads.ts";

const envelope = {
  session_id: "9c4bedcd-627e-4dcd-a959-9be3d3a69e9a",
  transcript_path:
    "/home/bjnwo/.claude/projects/-tmp-clobber-spike-9aAgSj/9c4bedcd-627e-4dcd-a959-9be3d3a69e9a.jsonl",
  cwd: "/tmp/clobber-spike-9aAgSj",
  permission_mode: "bypassPermissions",
} as const;

describe("HookPayloadSchema", () => {
  it("validates UserPromptSubmit (real payload from spike)", () => {
    const payload = {
      ...envelope,
      hook_event_name: "UserPromptSubmit",
      prompt: "Run the bash command `echo hello-from-clobber-spike` and then say done.",
    };
    const result = HookPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success && result.data.hook_event_name === "UserPromptSubmit") {
      expect(result.data.prompt).toContain("echo hello-from-clobber-spike");
    }
  });

  it("validates PreToolUse with Bash (real payload from spike)", () => {
    const payload = {
      ...envelope,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hello-from-clobber-spike", description: "Echo test string" },
      tool_use_id: "toolu_01A57kxGny7tLmXRKSXYVorr",
    };
    const result = HookPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success && result.data.hook_event_name === "PreToolUse") {
      expect(result.data.tool_name).toBe("Bash");
      expect(result.data.tool_use_id).toBe("toolu_01A57kxGny7tLmXRKSXYVorr");
    }
  });

  it("validates PostToolUse with Bash response (real payload from spike)", () => {
    const payload = {
      ...envelope,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hello-from-clobber-spike", description: "Echo test string" },
      tool_response: {
        stdout: "hello-from-clobber-spike",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
      tool_use_id: "toolu_01A57kxGny7tLmXRKSXYVorr",
    };
    const result = HookPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("validates envelope-only events (Stop, SessionEnd, Notification, PreCompact)", () => {
    for (const hook_event_name of ["Stop", "SessionEnd", "Notification", "PreCompact"] as const) {
      const result = HookPayloadSchema.safeParse({ ...envelope, hook_event_name });
      expect(result.success).toBe(true);
    }
  });

  it("validates SessionStart with optional source/model", () => {
    const result = HookPayloadSchema.safeParse({
      ...envelope,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "claude-opus-4-7",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown hook_event_name", () => {
    const result = HookPayloadSchema.safeParse({
      ...envelope,
      hook_event_name: "NotAnEvent",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown permission_mode", () => {
    const result = HookPayloadSchema.safeParse({
      ...envelope,
      permission_mode: "wide-open",
      hook_event_name: "Stop",
    });
    expect(result.success).toBe(false);
  });

  it("rejects payload missing session_id", () => {
    const partial: Record<string, unknown> = { ...envelope, hook_event_name: "Stop" };
    delete partial["session_id"];
    const result = HookPayloadSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("rejects PreToolUse missing tool_name", () => {
    const result = HookPayloadSchema.safeParse({
      ...envelope,
      hook_event_name: "PreToolUse",
      tool_input: {},
      tool_use_id: "toolu_x",
    });
    expect(result.success).toBe(false);
  });

  it("narrows the type via the discriminator", () => {
    const result = HookPayloadSchema.safeParse({
      ...envelope,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_x",
    });
    if (!result.success) throw new Error("expected success");
    if (result.data.hook_event_name === "PreToolUse") {
      const _check: string = result.data.tool_name;
      expect(_check).toBe("Bash");
    } else {
      throw new Error("expected PreToolUse branch");
    }
  });
});
