import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness, teardown, bootAgent, habit } from "./_habit-refuse-harness.ts";

function preToolUsePayload(
  sessionId: string,
  cwd: string,
  toolName: string,
  toolInput: Record<string, unknown>,
) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_test",
  } as const;
}

let repoPath: string;
let worktreePath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-refuse-repo-"));
  worktreePath = mkdtempSync(join(tmpdir(), "clobber-refuse-wt-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(worktreePath, { recursive: true, force: true });
});

// ── Inject regression (no regression after refuse is added) ───────────────────

describe("inject habit — no regression", () => {
  it("an inject habit still returns additionalContext on match", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "hint",
        match: "Edit",
        action: { kind: "inject", hint: "use small edits" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, repoPath, "Edit", {
        file_path: join(repoPath, "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toBe("use small edits");
    await teardown(h);
  });
});

// ── No-match / disabled → allow ───────────────────────────────────────────────

describe("no-match / disabled refuse habit → allow", () => {
  it("a refuse habit that does not match the tool name returns { continue: true }", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        match: "Edit|Write",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Bash", { command: "ls" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("a disabled refuse habit does not fire", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        enabled: false,
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, repoPath, "Edit", {
        file_path: join(repoPath, "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});

// ── Refuse → PreToolUse deny shape ────────────────────────────────────────────

describe("refuse habit → PreToolUse deny shape", () => {
  it("an Edit targeting the forbidden root returns the deny shape with the reason", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "main checkout is off-limits" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Edit", {
        file_path: join(repoPath, "packages", "server", "src", "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("main checkout is off-limits");
    await teardown(h);
  });

  it("a Write targeting the forbidden root returns the deny shape", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Write", {
        file_path: join(repoPath, "packages", "server", "src", "new-file.ts"),
        content: "export const x = 1;",
      }),
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });
});
