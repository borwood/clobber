import { describe, expect, it } from "bun:test";
import { claudeRuntimeProvider, codexRuntimeProvider } from "../src/runtime-provider.ts";
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
      inSessionHabits: true,
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

describe("codexRuntimeProvider", () => {
  it("declares Codex's turn-lifetime process capabilities", () => {
    expect(codexRuntimeProvider.id).toBe("codex");
    expect(codexRuntimeProvider.capabilities).toEqual({
      processLifetime: "turn",
      livePromptInjection: false,
      interrupt: false,
      resume: true,
      inSessionHabits: false,
      requiresPrompt: true,
    });
  });

  it("builds a first-turn codex exec request", () => {
    const req = codexRuntimeProvider.buildSpawnRequest({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "do work",
      cwd: "/repo",
      sessionId: "local-session-1",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
      env: { CLOBBER_SESSION_ID: "local-session-1" },
      materialized: {
        pluginDir: "/repo/.clobber/roles/worker",
        binDir: "/repo/.clobber/bin",
      },
      systemPrompt: "You are a worker.",
      displayName: "fix-bug",
    });

    expect(req).toMatchObject({
      hookUrl: "http://127.0.0.1:3300/hook",
      cwd: "/repo",
      sessionId: "local-session-1",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
      env: { CLOBBER_SESSION_ID: "local-session-1" },
      appendSystemPrompt: "You are a worker.",
      displayName: "fix-bug",
      command: {
        bin: "codex",
        stdoutEventFormat: "codex-jsonl",
      },
    });
    expect(req.command!.args).toEqual([
      "exec",
      "--json",
      "--cd",
      "/repo",
      "--dangerously-bypass-approvals-and-sandbox",
      req.prompt!,
    ]);
    expect(req.prompt).toContain("You are a worker.");
    expect(req.prompt).toContain("do work");
    expect(req.providerThreadId).toBeUndefined();
    expect(req.resume).toBeUndefined();
  });

  it("builds a codex exec resume request with the provider thread id", () => {
    const req = codexRuntimeProvider.buildResumeRequest!({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "continue",
      cwd: "/repo",
      sessionId: "local-session-1",
      providerThreadId: "019e0b86-a368-7702-9bf3-f5dce89dc9e9",
      env: { CLOBBER_SESSION_ID: "local-session-1" },
      materialized: {
        pluginDir: "/repo/.clobber/roles/worker",
        binDir: "/repo/.clobber/bin",
      },
      systemPrompt: "You are a worker.",
    });

    expect(req.providerThreadId).toBe("019e0b86-a368-7702-9bf3-f5dce89dc9e9");
    expect(req.resume).toBe(true);
    expect(req.command).toEqual({
      bin: "codex",
      args: [
        "exec",
        "resume",
        "019e0b86-a368-7702-9bf3-f5dce89dc9e9",
        "--json",
        req.prompt!,
      ],
      stdoutEventFormat: "codex-jsonl",
    });
  });
});
