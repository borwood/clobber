// Path-jail predicate edge cases + Bash write-target extraction tests for the
// refuse action kind. Covers redirect (>), cp, mv, sed -i destinations against
// both the forbidden root and the allowed worktree, plus allow cases
// (in-worktree, desk-exempt, under-subzone, read-only Bash).
//
// See tool-write-targets.ts for the best-effort contract: interpreter-mediated
// writes (python3 -c, perl, heredocs) are NOT caught by command-string parsing.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ── Allow cases ───────────────────────────────────────────────────────────────

describe("path-jail predicate: allow cases", () => {
  it("in-worktree: a Write to the worktree (not under outside) is allowed", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath } } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: boot.sessionId, transcript_path: "/tmp/t.jsonl", cwd: worktreePath,
        permission_mode: "bypassPermissions", hook_event_name: "PreToolUse", tool_name: "Write",
        tool_input: { file_path: join(worktreePath, "packages", "foo.ts"), content: "x" },
        tool_use_id: "toolu_a",
      },
    });
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("desk-except: a Write to the .clobber/agents dir (under except) is allowed", async () => {
    const deskDir = join(repoPath, ".clobber", "agents", "test-agent", "desk");
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use", name: "j",
        action: { kind: "refuse", predicate: { outside: repoPath, except: join(repoPath, ".clobber", "agents") } },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: boot.sessionId, transcript_path: "/tmp/t.jsonl", cwd: worktreePath,
        permission_mode: "bypassPermissions", hook_event_name: "PreToolUse", tool_name: "Write",
        tool_input: { file_path: join(deskDir, "notes.md"), content: "ok" },
        tool_use_id: "toolu_b",
      },
    });
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("under-subzone: a Write inside the `under` subzone is allowed even though outside=repoPath", async () => {
    const allowed = join(repoPath, "allowed-subdir");
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath, under: allowed } } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: {
        session_id: boot.sessionId, transcript_path: "/tmp/t.jsonl", cwd: worktreePath,
        permission_mode: "bypassPermissions", hook_event_name: "PreToolUse", tool_name: "Write",
        tool_input: { file_path: join(allowed, "foo.ts"), content: "x" },
        tool_use_id: "toolu_c",
      },
    });
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("read-only Bash (no write intent) is always allowed", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath } } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath, `cat ${join(repoPath, "README.md")}`),
    });
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("Bash cp to worktree is allowed", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath } } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath,
        `cp src.ts ${join(worktreePath, "packages", "dst.ts")}`),
    });
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("Bash mv to worktree is allowed", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath } } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath,
        `mv src.ts ${join(worktreePath, "packages", "dst.ts")}`),
    });
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("Bash sed -i to worktree is allowed", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath } } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath,
        `sed -i 's/old/new/g' ${join(worktreePath, "packages", "foo.ts")}`),
    });
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});

// ── Deny cases ────────────────────────────────────────────────────────────────

describe("path-jail predicate: deny cases", () => {
  it("Bash redirect (>) into the main checkout is denied", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath,
        `echo x > ${join(repoPath, "packages", "foo.ts")}`),
    });
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });

  it("Bash cp into the main checkout is denied", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath,
        `cp src.ts ${join(repoPath, "packages", "dst.ts")}`),
    });
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });

  it("Bash mv into the main checkout is denied", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath,
        `mv src.ts ${join(repoPath, "packages", "dst.ts")}`),
    });
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });

  it("Bash sed -i into the main checkout is denied", async () => {
    const h = buildHarness(() => [
      habit({ path: "self.tool-use", name: "j", action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" } }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: bashPayload(boot.sessionId, worktreePath,
        `sed -i 's/old/new/g' ${join(repoPath, "packages", "foo.ts")}`),
    });
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });
});
