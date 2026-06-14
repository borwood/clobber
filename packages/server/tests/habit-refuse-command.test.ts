// #648 — deny on match_command alone (no PathJail predicate).
// A `self.tool-use` refuse habit with `match_command` and no `predicate`
// should deny the matching Bash PreToolUse without requiring a path jail.
//
// Best-effort ceiling: freehand Bash and force-skill invocations can be blocked
// by command-string matching. Evasion via heredoc, --body-file, or interpreter
// (python3 -c, perl -e) is NOT caught. Over-blocking on innocent command
// mentions (comments, echo) is possible.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HabitSchema } from "@clobber/shared";
import { buildHarness, teardown, bootAgent, habit } from "./_habit-refuse-harness.ts";

function bashPayload(sessionId: string, cwd: string, command: string) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_cmd_test",
  } as const;
}

function nonBashPayload(sessionId: string, cwd: string) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(cwd, "foo.ts"), old_string: "a", new_string: "b" },
    tool_use_id: "toolu_edit_test",
  } as const;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-refuse-cmd-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

// ── Deny on match_command alone ───────────────────────────────────────────────

describe("command-predicate refuse: deny on match_command (no predicate)", () => {
  it("matching Bash command is denied with the habit reason", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "block-rm",
        match_command: "rm\\s+-rf",
        action: { kind: "refuse", reason: "rm -rf is forbidden" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, repoPath, "rm -rf /tmp/foo"),
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("rm -rf is forbidden");
    await teardown(h);
  });

  it("matching Bash command with no reason uses the default denial message", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "block-push",
        match_command: "git push.*--force",
        action: { kind: "refuse" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, repoPath, "git push --force origin main"),
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });
});

// ── Allow on non-matching command ─────────────────────────────────────────────

describe("command-predicate refuse: allow on non-matching Bash command", () => {
  it("non-matching Bash command passes through", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "block-rm",
        match_command: "rm\\s+-rf",
        action: { kind: "refuse", reason: "rm -rf is forbidden" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, repoPath, "ls -la"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});

// ── Allow on non-Bash tool ────────────────────────────────────────────────────

describe("command-predicate refuse: allow on non-Bash tool call", () => {
  it("an Edit PreToolUse is not matched by match_command and passes through", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "block-rm",
        match_command: "rm\\s+-rf",
        action: { kind: "refuse", reason: "rm -rf is forbidden" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: nonBashPayload(boot.sessionId, repoPath),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});

// ── Path-jail habits unaffected ───────────────────────────────────────────────

describe("command-predicate refuse: path-jail habits with predicate unaffected", () => {
  it("a refuse habit WITH predicate still uses isPathJailed (deny on jailed path)", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "path-jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: boot.sessionId,
        transcript_path: "/tmp/t.jsonl",
        cwd: repoPath,
        permission_mode: "bypassPermissions",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(repoPath, "packages", "evil.ts"), content: "x" },
        tool_use_id: "toolu_jail",
      },
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });

  it("a refuse habit WITH predicate still uses isPathJailed (allow on safe path)", async () => {
    const safeDir = mkdtempSync(join(tmpdir(), "clobber-safe-"));
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "path-jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: boot.sessionId,
        transcript_path: "/tmp/t.jsonl",
        cwd: safeDir,
        permission_mode: "bypassPermissions",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(safeDir, "foo.ts"), content: "x" },
        tool_use_id: "toolu_safe",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    rmSync(safeDir, { recursive: true, force: true });
    await teardown(h);
  });
});

// ── Schema regression: predicate-less + match-less refuse must be rejected ────

describe("HabitSchema validation: predicate-less refuse without match criterion", () => {
  it("rejects a refuse habit with no predicate AND no match/match_command/match_path", () => {
    const result = HabitSchema.safeParse({
      path: "self.tool-use",
      name: "deny-all",
      action: { kind: "refuse", reason: "oops" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages).toContain("deny-all");
    }
  });

  it("accepts a refuse habit with no predicate but with match_command set", () => {
    const result = HabitSchema.safeParse({
      path: "self.tool-use",
      name: "block-rm",
      match_command: "rm\\s+-rf",
      action: { kind: "refuse", reason: "forbidden" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a refuse habit with no predicate but with match set", () => {
    const result = HabitSchema.safeParse({
      path: "self.tool-use",
      name: "block-all-tools",
      match: ".*",
      action: { kind: "refuse", reason: "explicit deny-all via match" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a refuse habit WITH predicate and no match criterion (path-jail only)", () => {
    const result = HabitSchema.safeParse({
      path: "self.tool-use",
      name: "path-jail",
      action: { kind: "refuse", predicate: { outside: "/some/path" }, reason: "jailed" },
    });
    expect(result.success).toBe(true);
  });
});
