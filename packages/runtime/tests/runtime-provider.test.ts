import { describe, expect, it } from "bun:test";
import { claudeRuntimeProvider } from "../src/runtime-provider.ts";
import {
  serializeInterruptRequest,
  serializeUserMessage,
} from "../src/stream-json.ts";
import { deriveTranscriptPath } from "../src/transcript-path.ts";

describe("claudeRuntimeProvider", () => {
  it("declares Claude's session-lifetime process capabilities", () => {
    expect(claudeRuntimeProvider.id).toBe("claude");
    expect(claudeRuntimeProvider.capabilities).toEqual({
      processLifetime: "session",
      livePromptInjection: true,
      interrupt: true,
      resume: true,
    });
  });

  it("owns Claude prompt and interrupt serialization", () => {
    expect(claudeRuntimeProvider.serializeUserPrompt("hello")).toBe(
      serializeUserMessage("hello"),
    );
    expect(claudeRuntimeProvider.serializeInterrupt("req-1")).toBe(
      serializeInterruptRequest("req-1"),
    );
  });

  it("owns Claude transcript path derivation", () => {
    expect(claudeRuntimeProvider.transcriptPath("/tmp/my_repo", "s1")).toBe(
      deriveTranscriptPath("/tmp/my_repo", "s1"),
    );
  });

  it("builds the Claude spawn request from materialized role state", () => {
    const req = claudeRuntimeProvider.buildSpawnRequest({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "do work",
      cwd: "/repo",
      sessionId: "00000000-0000-4000-8000-000000000001",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
      env: { CLOBBER_SESSION_ID: "s1" },
      materialized: {
        pluginDir: "/repo/.clobber/roles/worker",
        binDir: "/repo/.clobber/bin",
      },
      systemPrompt: "You are a worker.",
      displayName: "fix-bug",
    });

    expect(req).toEqual({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "do work",
      cwd: "/repo",
      sessionId: "00000000-0000-4000-8000-000000000001",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
      env: { CLOBBER_SESSION_ID: "s1" },
      pluginDirs: ["/repo/.clobber/roles/worker"],
      appendSystemPrompt: "You are a worker.",
      displayName: "fix-bug",
    });
  });
});
